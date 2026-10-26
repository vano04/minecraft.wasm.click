// SPDX-License-Identifier: GPL-3.0-only
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	qrcode "github.com/skip2/go-qrcode"
)

//go:embed licenses/*
var licenses embed.FS

const site = "https://minecraft.wasm.click"

var version = "development"
var errConnectionEnded = errors.New("Browser connection ended. Restart the command to pair again.")
var requestPattern = regexp.MustCompile("^[a-f0-9]{32}$")
var streamPattern = regexp.MustCompile("^mcweb-stream-[a-f0-9-]{1,80}$")
var packPattern = regexp.MustCompile("^mcweb-pack-[a-f0-9-]{1,80}$")

type terminal struct {
	mu  sync.Mutex
	out io.Writer
}

func (t *terminal) printf(format string, args ...any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	fmt.Fprintf(t.out, format, args...)
}

type host struct {
	pc                             *webrtc.PeerConnection
	ws                             *websocket.Conn
	listener                       net.Listener
	server                         *http.Server
	ctx                            context.Context
	cancel                         context.CancelFunc
	term                           *terminal
	secret, token, pending, ticket string
	paired                         atomic.Bool
	active                         atomic.Int32
	writeMu, promptMu              sync.Mutex
	requests                       chan string
	fatal                          chan error
	control                        *webrtc.DataChannel
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}
func encoded(value any) string {
	b, _ := json.Marshal(value)
	return base64.RawURLEncoding.EncodeToString(b)
}
func equal(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func (h *host) fail(err error) {
	select {
	case h.fatal <- err:
	default:
	}
}
func (h *host) send(value any) error {
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	_ = h.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return h.ws.WriteJSON(value)
}
func (h *host) close() {
	h.cancel()
	if h.ws != nil {
		h.ws.Close()
	}
	if h.server != nil {
		h.server.Close()
	}
	if h.listener != nil {
		h.listener.Close()
	}
	if h.pc != nil {
		h.pc.Close()
	}
}

func newHost(ctx context.Context, term *terminal) (*host, error) {
	ctx, cancel := context.WithCancel(ctx)
	h := &host{ctx: ctx, cancel: cancel, term: term, secret: base64.RawURLEncoding.EncodeToString(randomBytes(32)), token: hex.EncodeToString(randomBytes(32)), requests: make(chan string, 1), fatal: make(chan error, 1)}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}})
	if err != nil {
		cancel()
		return nil, err
	}
	h.pc = pc
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed {
			if h.paired.Load() {
				h.fail(errConnectionEnded)
			} else {
				h.fail(errors.New("direct connection failed; check local-network permission, firewall and Wi-Fi isolation"))
			}
		}
		if state == webrtc.PeerConnectionStateClosed && ctx.Err() == nil {
			h.fail(errConnectionEnded)
		}
	})
	control, err := pc.CreateDataChannel("mcweb-control", nil)
	if err != nil {
		h.close()
		return nil, err
	}
	h.control = control
	control.OnMessage(func(message webrtc.DataChannelMessage) {
		var proof struct{ Proof string }
		if !message.IsString || len(message.Data) > 256 || json.Unmarshal(message.Data, &proof) != nil || !equal(proof.Proof, h.secret) || !h.paired.CompareAndSwap(false, true) {
			h.fail(errors.New("invalid pairing proof"))
			return
		}
		if err := control.SendText("{\"paired\":true}"); err != nil {
			h.fail(err)
			return
		}
		h.term.printf("\nPaired. Keep this terminal open while playing. Stop with Ctrl+C.\n")
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		pack := packPattern.MatchString(dc.Label())
		if !h.paired.Load() || (!streamPattern.MatchString(dc.Label()) && !pack) {
			dc.Close()
			return
		}
		if h.active.Add(1) > 12 {
			h.active.Add(-1)
			dc.Close()
			return
		}
		p := newPipe(ctx, func(text bool, b []byte) error {
			for dc.BufferedAmount() > 256*1024 {
				if dc.ReadyState() != webrtc.DataChannelStateOpen {
					return errors.New("stream closed")
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(8 * time.Millisecond):
				}
			}
			if text {
				return dc.SendText(string(b))
			}
			return dc.Send(b)
		}, func() { dc.Close(); h.active.Add(-1) })
		p.pack = pack
		dc.OnMessage(func(m webrtc.DataChannelMessage) { p.receive(m.IsString, m.Data) })
		dc.OnClose(p.close)
		dc.OnError(func(error) { p.close() })
		dc.OnOpen(func() {
			if pack {
				go p.runPack(nil)
			} else {
				go p.run()
			}
		})
	})
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		h.close()
		return nil, err
	}
	h.listener = listener
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == site }}
	h.server = &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/socket" || r.Method != "GET" || r.Host != listener.Addr().String() {
			http.NotFound(w, r)
			return
		}
		if h.active.Add(1) > 12 {
			h.active.Add(-1)
			http.Error(w, "Busy", 429)
			return
		}
		defer h.active.Add(-1)
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.SetReadLimit(65536)
		_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
		kind, body, err := ws.ReadMessage()
		var auth struct{ Token, Kind string }
		if err != nil || kind != websocket.TextMessage || len(body) > 160 || json.Unmarshal(body, &auth) != nil || !equal(auth.Token, h.token) {
			return
		}
		_ = ws.SetReadDeadline(time.Time{})
		p := newPipe(ctx, func(text bool, b []byte) error {
			kind := websocket.BinaryMessage
			if text {
				kind = websocket.TextMessage
			}
			_ = ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
			return ws.WriteMessage(kind, b)
		}, func() { ws.Close() })
		p.pack = auth.Kind == "pack"
		defer p.close()
		if p.pack {
			go p.runPack(nil)
		} else {
			go p.run()
		}
		for {
			kind, body, err = ws.ReadMessage()
			if err != nil {
				return
			}
			p.receive(kind == websocket.TextMessage, body)
		}
	})}
	go func() {
		if err := h.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.fail(err)
		}
	}()
	return h, nil
}

func (h *host) register() error {
	offer, err := h.pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	complete := webrtc.GatheringCompletePromise(h.pc)
	if err = h.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-complete:
	case <-time.After(6 * time.Second):
	case <-h.ctx.Done():
		return h.ctx.Err()
	}
	sdp := h.pc.LocalDescription().SDP
	if len(sdp) > 24000 || !strings.Contains(sdp, "a=candidate:") {
		return errors.New("no direct network addresses available")
	}
	alphabet := "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	room := make([]byte, 8)
	for i, b := range randomBytes(8) {
		room[i] = alphabet[int(b)&31]
	}
	expires := time.Now().Add(10 * time.Minute).UnixMilli()
	fingerprint := sha256.Sum256([]byte(sdp))
	h.ticket = encoded(map[string]any{"v": 1, "protocol": "webrtc", "room": string(room), "secret": h.secret, "expiresAt": expires, "fingerprint": base64.RawURLEncoding.EncodeToString(fingerprint[:]), "direct": map[string]string{"url": "ws://" + h.listener.Addr().String() + "/socket", "token": h.token}})
	// The rendezvous protocol distinguishes native/local hosts from the website Origin.
	// This header does not expose an HTTP helper page or grant access to localhost.
	ws, response, err := websocket.DefaultDialer.DialContext(h.ctx, "wss://minecraft.wasm.click/relay/signal?room="+string(room), http.Header{"Origin": []string{"http://127.0.0.1:1"}})
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return fmt.Errorf("pairing service unavailable: %w", err)
	}
	h.ws = ws
	ws.SetReadLimit(32768)
	if err = h.send(map[string]any{"role": "host", "secret": h.secret, "expiresAt": expires, "offer": sdp}); err != nil {
		return err
	}
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	var message struct{ Type string }
	if err = ws.ReadJSON(&message); err != nil {
		return err
	}
	if message.Type != "registered" {
		return errors.New("pairing service refused registration")
	}
	_ = ws.SetReadDeadline(time.Time{})
	link := site + "/relay/pair#" + string(room)
	h.term.printf("\nminecraft.wasm.click relay %s\nNo helper page. Keep this terminal open. Stop with Ctrl+C.\n\nPairing code: %s-%s\n", version, room[:4], room[4:])
	qr, err := qrcode.New(link, qrcode.Medium)
	if err != nil {
		return err
	}
	h.term.printf("\n%s\nPairing link: %s\nScan the QR or enter the code in launcher Settings → Local relay.\nApprove only the connection you are starting. This code expires in 10 minutes.\n", terminalQR(qr.Bitmap()), link)
	return nil
}

func terminalQR(rows [][]bool) string {
	var out strings.Builder
	for y := 0; y < len(rows); y += 2 {
		out.WriteString("\x1b[47m\x1b[30m")
		for x, top := range rows[y] {
			bottom := y+1 < len(rows) && rows[y+1][x]
			switch {
			case top && bottom:
				out.WriteRune('█')
			case top:
				out.WriteRune('▀')
			case bottom:
				out.WriteRune('▄')
			default:
				out.WriteByte(' ')
			}
		}
		out.WriteString("\x1b[0m\n")
	}
	return out.String()
}

func (h *host) readSignal() {
	for {
		var value struct{ Type, ID, SDP string }
		if err := h.ws.ReadJSON(&value); err != nil {
			if !h.paired.Load() {
				h.fail(errors.New("pairing expired or disconnected; restart the command for a new code"))
			}
			return
		}
		switch value.Type {
		case "request":
			if !requestPattern.MatchString(value.ID) {
				h.fail(errors.New("invalid approval request"))
				return
			}
			h.promptMu.Lock()
			h.pending = value.ID
			h.promptMu.Unlock()
			select {
			case h.requests <- value.ID:
			default:
			}
		case "request-ended":
			h.promptMu.Lock()
			if h.pending == value.ID {
				h.pending = ""
			}
			h.promptMu.Unlock()
		case "answer":
			if h.pc.RemoteDescription() != nil || len(value.SDP) > 24000 {
				h.fail(errors.New("invalid pairing answer"))
				return
			}
			if err := h.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: value.SDP}); err != nil {
				h.fail(err)
				return
			}
		case "direct":
			if h.paired.CompareAndSwap(false, true) {
				h.term.printf("\nPaired directly on this computer. Keep this terminal open while playing.\n")
			}
		default:
			h.fail(errors.New("unexpected pairing message"))
			return
		}
	}
}

func (h *host) approve(id, line string) {
	h.promptMu.Lock()
	defer h.promptMu.Unlock()
	if h.pending != id {
		h.term.printf("Request expired. Connect again to request a new approval.\n")
		return
	}
	typeName := "deny"
	if strings.EqualFold(strings.TrimSpace(line), "y") || strings.EqualFold(strings.TrimSpace(line), "yes") {
		typeName = "approve"
	}
	message := map[string]string{"type": typeName, "id": id}
	if typeName == "approve" {
		message["code"] = h.ticket
	}
	h.pending = ""
	if err := h.send(message); err != nil {
		h.fail(err)
		return
	}
	h.term.printf("Connection %s.\n", map[bool]string{true: "approved", false: "declined"}[typeName == "approve"])
}

func main() {
	showVersion := flag.Bool("version", false, "print version")
	showLicenses := flag.Bool("licenses", false, "print bundled third-party licenses")
	flag.Parse()
	if *showVersion {
		fmt.Println("minecraft.wasm.click relay", version)
		return
	}
	if *showLicenses {
		entries, _ := licenses.ReadDir("licenses")
		for _, entry := range entries {
			body, _ := licenses.ReadFile("licenses/" + entry.Name())
			fmt.Printf("\n--- %s ---\n%s\n", entry.Name(), body)
		}
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	h, err := newHost(ctx, &terminal{out: os.Stdout})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = h.register(); err != nil {
		h.close()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	go h.readSignal()
	lines := make(chan string)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 1024), 4096)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
		close(lines)
	}()
	var request string
	for {
		select {
		case <-ctx.Done():
			h.close()
			fmt.Println("\nRelay stopped.")
			return
		case err := <-h.fatal:
			h.close()
			if errors.Is(err, errConnectionEnded) {
				fmt.Println(err)
				return
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		case id := <-h.requests:
			request = id
			h.term.printf("\nA device entered your code. Allow this connection? [y/N]: ")
		case line, ok := <-lines:
			if !ok {
				lines = nil
				if !h.paired.Load() {
					h.term.printf("\nNo interactive input. Run this command in a terminal to approve pairing.\n")
				}
				continue
			}
			if request != "" {
				h.approve(request, line)
				request = ""
			}
		}
	}
}
