// SPDX-License-Identifier: GPL-3.0-only
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTCPTransferAndBackpressure(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	inbound, outbound := make([]byte, 1536*1024), make([]byte, 128*1024)
	for i := range inbound {
		inbound[i] = byte(i % 251)
	}
	for i := range outbound {
		outbound[i] = byte(i % 239)
	}
	got := make(chan []byte, 1)
	go func() {
		c, err := listener.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(10 * time.Second))
		go func() { _, _ = c.Write(inbound) }()
		b := make([]byte, len(outbound))
		_, _ = io.ReadFull(c, b)
		got <- b
		<-time.After(2 * time.Second)
	}()
	messages := make(chan wireMessage, 128)
	p := newPipe(context.Background(), func(text bool, b []byte) error { messages <- wireMessage{text, append([]byte(nil), b...)}; return nil }, func() {})
	defer p.close()
	go p.run()
	host, _, _ := net.SplitHostPort(listener.Addr().String())
	connect, _ := json.Marshal(map[string]any{"connect": map[string]any{"host": host, "port": listener.Addr().(*net.TCPAddr).Port}})
	p.receive(true, connect)

	received := []byte{}
	connected := false
	deadline := time.After(5 * time.Second)
	for !connected {
		select {
		case m := <-messages:
			if m.text {
				connected = bytes.Contains(m.data, []byte("connected"))
			} else {
				received = append(received, m.data...)
			}
		case <-deadline:
			t.Fatal("TCP did not connect")
		}
	}
	time.Sleep(150 * time.Millisecond)
	for len(messages) > 0 {
		m := <-messages
		if !m.text {
			received = append(received, m.data...)
		}
	}
	if len(received) == 0 || len(received) > maxQueue+32768 || len(received) >= len(inbound) {
		t.Fatalf("backpressure missing: %d bytes", len(received))
	}
	ack, _ := json.Marshal(map[string]int{"received": len(received)})
	p.receive(true, ack)
	for i := 0; i < len(outbound); i += 32768 {
		p.receive(false, outbound[i:i+32768])
	}
	for len(received) < len(inbound) {
		select {
		case m := <-messages:
			if !m.text {
				b := m.data
				received = append(received, b...)
				ack, _ := json.Marshal(map[string]int{"received": len(b)})
				p.receive(true, ack)
			}
		case <-deadline:
			t.Fatal("TCP transfer timed out")
		}
	}
	if !bytes.Equal(received, inbound) {
		t.Fatal("inbound bytes differ")
	}
	select {
	case b := <-got:
		if !bytes.Equal(b, outbound) {
			t.Fatal("outbound bytes differ")
		}
	case <-deadline:
		t.Fatal("outbound timed out")
	}
	p.receive(true, []byte("{\"received\":99999999}"))
	select {
	case <-p.ctx.Done():
	case <-deadline:
		t.Fatal("invalid receive acknowledgement was accepted")
	}
}

func TestLoopbackIsNotAHelperPageAndRequiresOriginAndToken(t *testing.T) {
	h, err := newHost(context.Background(), &terminal{out: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer h.close()
	base := "http://" + h.listener.Addr().String()
	response, err := http.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal("an HTTP helper page was exposed")
	}
	_, response, err = websocket.DefaultDialer.Dial("ws://"+h.listener.Addr().String()+"/socket", http.Header{"Origin": []string{"https://untrusted.example"}})
	if err == nil {
		t.Fatal("foreign Origin accepted")
	}
	if response != nil {
		response.Body.Close()
	}
	ws, _, err := websocket.DefaultDialer.Dial("ws://"+h.listener.Addr().String()+"/socket", http.Header{"Origin": []string{site}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.WriteJSON(map[string]string{"token": "incorrect"})
	_ = ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err = ws.ReadMessage(); err == nil {
		t.Fatal("invalid token accepted")
	}
}

func TestInvalidTargetAndUnapprovedStream(t *testing.T) {
	for _, value := range []struct {
		host string
		port int
	}{{"", 25565}, {"a", 0}, {"a", 65536}, {"a/b", 25565}, {"a..b", 25565}} {
		if _, err := target(value.host, value.port); err == nil {
			t.Fatalf("unsafe target accepted: %v", value)
		}
	}

	p := newPipe(context.Background(), func(bool, []byte) error { return nil }, func() {})
	go p.run()
	p.receive(false, []byte("no CONNECT"))
	select {
	case <-p.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("DATA without CONNECT accepted")
	}
}

func TestBrowserDisconnectHasNormalExit(t *testing.T) {
	h, err := newHost(context.Background(), &terminal{out: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer h.close()
	h.paired.Store(true)
	if err = h.pc.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-h.fatal:
		if !errors.Is(err, errConnectionEnded) {
			t.Fatalf("normal disconnect reported as failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("missing disconnect notification")
	}
}
