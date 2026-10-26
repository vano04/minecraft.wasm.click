// SPDX-License-Identifier: GPL-3.0-only
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const maxQueue = 1024 * 1024

var hostnamePattern = regexp.MustCompile("^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$")

type wireMessage struct {
	text bool
	data []byte
}
type pipe struct {
	ctx       context.Context
	cancel    context.CancelFunc
	in        chan wireMessage
	send      func(bool, []byte) error
	closeWire func()
	queued    atomic.Int64
	closed    atomic.Bool
	pack      bool
}

func newPipe(ctx context.Context, send func(bool, []byte) error, closeWire func()) *pipe {
	ctx, cancel := context.WithCancel(ctx)
	return &pipe{ctx: ctx, cancel: cancel, in: make(chan wireMessage, 64), send: send, closeWire: closeWire}
}
func (p *pipe) close() {
	if p.closed.CompareAndSwap(false, true) {
		p.cancel()
		p.closeWire()
	}
}
func (p *pipe) receive(text bool, data []byte) {
	if p.closed.Load() {
		return
	}
	textLimit := 1024
	if p.pack {
		textLimit = 8192
	}
	if len(data) > 65536 || (text && len(data) > textLimit) || p.queued.Add(int64(len(data))) > maxQueue {
		p.close()
		return
	}
	message := wireMessage{text, append([]byte(nil), data...)}
	select {
	case p.in <- message:
	case <-p.ctx.Done():
	default:
		p.close()
	}
}
func target(hostname string, port int) (string, error) {
	if port < 1 || port > 65535 || !hostnamePattern.MatchString(hostname) || strings.Contains(hostname, "..") {
		return "", fmt.Errorf("invalid TCP target")
	}
	return net.JoinHostPort(hostname, strconv.Itoa(port)), nil
}

func (p *pipe) run() {
	defer p.close()
	var conn net.Conn
	defer func() {
		if conn != nil {
			conn.Close()
		}
	}()
	if p.send(true, []byte(`{"relay":{"version":1,"windowBytes":1048576}}`)) != nil {
		return
	}
	startup := time.NewTimer(15 * time.Second)
	defer startup.Stop()
	type tcpRead struct {
		data []byte
		err  error
	}
	reads := make(chan tcpRead)
	var incoming <-chan tcpRead
	outstanding := 0
	for {
		allowed := incoming
		if outstanding >= maxQueue {
			allowed = nil
		}
		select {
		case <-p.ctx.Done():
			return
		case <-startup.C:
			return
		case read := <-allowed:
			if len(read.data) > 0 {
				if p.send(false, read.data) != nil {
					return
				}
				outstanding += len(read.data)
			}
			if read.err != nil {
				return
			}
		case message := <-p.in:
			p.queued.Add(-int64(len(message.data)))
			if message.text {
				var control struct {
					Connect *struct {
						Host string
						Port int
					}
					Received int
				}
				if json.Unmarshal(message.data, &control) != nil {
					return
				}
				if control.Connect != nil {
					if conn != nil {
						return
					}
					address, err := target(control.Connect.Host, control.Connect.Port)
					if err != nil {
						return
					}
					dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
					conn, err = dialer.DialContext(p.ctx, "tcp", address)
					if err != nil {
						_ = p.send(true, []byte(`{"error":"Minecraft server could not be reached"}`))
						return
					}
					startup.Stop()
					if p.send(true, []byte(`{"connected":true}`)) != nil {
						return
					}
					incoming = reads
					go func(c net.Conn) {
						for {
							buf := make([]byte, 32768)
							n, err := c.Read(buf)
							select {
							case reads <- tcpRead{buf[:n], err}:
							case <-p.ctx.Done():
								return
							}
							if err != nil {
								return
							}
						}
					}(conn)
				} else {
					if control.Received <= 0 || control.Received > outstanding {
						return
					}
					outstanding -= control.Received
				}
				continue
			}
			if conn == nil || len(message.data) == 0 || len(message.data) > 65536 {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
			data := message.data
			for len(data) > 0 {
				n, err := conn.Write(data)
				if err != nil || n <= 0 {
					return
				}
				data = data[n:]
			}
			ack, _ := json.Marshal(map[string]int{"written": len(message.data)})
			if p.send(true, ack) != nil {
				return
			}
		}
	}
}
