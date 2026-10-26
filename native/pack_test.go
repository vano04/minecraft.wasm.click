// SPDX-License-Identifier: GPL-3.0-only
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"testing"
	"time"
)

type packRoundTrip func(*http.Request) (*http.Response, error)

func (f packRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPackRejectsPrivateHostsAndNonHTTPSURLs(t *testing.T) {
	for _, value := range []string{"http://packs.example/a.zip", "https://user:secret@packs.example/a.zip", "https://packs.example:444/a.zip", "https://localhost/a.zip", "https://metadata/a.zip", "https://127.0.0.1/a.zip", "https://[::ffff:127.0.0.1]/a.zip"} {
		if _, err := packURL(value); err == nil {
			t.Fatalf("unsafe pack URL accepted: %s", value)
		}
	}
	for _, value := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.1.2", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1"} {
		if publicPackIP(netip.MustParseAddr(value)) {
			t.Fatalf("private or reserved pack address accepted: %s", value)
		}
	}
	u, err := packURL("https://packs.example/a.zip#hash")
	if err != nil || u.String() != "https://packs.example/a.zip" {
		t.Fatal("pack URL did not preserve its HTTPS path")
	}
}

func TestPackStreamUsesPullCreditAndExactBoundedBytes(t *testing.T) {
	body := bytes.Repeat([]byte("original pack bytes"), 12000)
	messages := make(chan wireMessage, 32)
	p := newPipe(context.Background(), func(text bool, value []byte) error {
		messages <- wireMessage{text, append([]byte(nil), value...)}
		return nil
	}, func() {})
	p.pack = true
	client := &http.Client{Transport: packRoundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://packs.example/original.zip" || req.Method != "GET" || req.Header.Get("Authorization") != "" || req.Header.Get("Cookie") != "" || req.Header.Get("Referer") != "" {
			t.Error("pack request URL or credential isolation differs")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Header: make(http.Header)}, nil
	})}
	go p.runPack(client)
	p.receive(true, []byte(`{"url":"https://packs.example/original.zip#hash"}`))
	deadline := time.After(5 * time.Second)
	select {
	case metadata := <-messages:
		if !metadata.text || string(metadata.data) != `{"status":200}` {
			t.Fatalf("invalid pack metadata: %s", metadata.data)
		}
	case <-deadline:
		t.Fatal("pack metadata timed out")
	}
	select {
	case <-messages:
		t.Fatal("body sent before pull credit")
	case <-time.After(20 * time.Millisecond):
	}
	var got []byte
	for {
		p.receive(true, []byte(`{"pull":true}`))
		select {
		case message := <-messages:
			if message.text {
				var end struct{ EOF bool }
				if json.Unmarshal(message.data, &end) != nil || !end.EOF {
					t.Fatalf("unexpected pack response: %s", message.data)
				}
				if !bytes.Equal(got, body) {
					t.Fatal("pack bytes differ")
				}
				return
			}
			if len(message.data) > 32768 {
				t.Fatal("pack chunk exceeds limit")
			}
			got = append(got, message.data...)
		case <-deadline:
			t.Fatal("pack body timed out")
		}
	}
}

func TestPackDisconnectCancelsUpstream(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	p := newPipe(context.Background(), func(bool, []byte) error { return nil }, func() {})
	p.pack = true
	go p.runPack(&http.Client{Transport: packRoundTrip(func(req *http.Request) (*http.Response, error) {
		close(started)
		<-req.Context().Done()
		close(cancelled)
		return nil, req.Context().Err()
	})})
	p.receive(true, []byte(`{"url":"https://packs.example/a.zip"}`))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("pack did not start")
	}
	p.close()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream survived disconnect")
	}
}

func TestPackWindowStreamsEightChunksWithoutEightRoundTrips(t *testing.T) {
	messages := make(chan wireMessage, 32)
	p := newPipe(context.Background(), func(text bool, b []byte) error {
		messages <- wireMessage{text, append([]byte(nil), b...)}
		return nil
	}, func() {})
	p.pack = true
	defer p.close()
	go p.runPack(&http.Client{Transport: packRoundTrip(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(make([]byte, 9*32768))), Header: make(http.Header)}, nil
	})})
	p.receive(true, []byte(`{"url":"https://packs.example/window.zip"}`))
	select {
	case <-messages:
	case <-time.After(time.Second):
		t.Fatal("pack metadata timed out")
	}
	p.receive(true, []byte(`{"pull":8}`))
	for i := 0; i < 8; i++ {
		select {
		case message := <-messages:
			if message.text || len(message.data) != 32768 {
				t.Fatal("invalid window chunk")
			}
		case <-time.After(time.Second):
			t.Fatal("window did not fill")
		}
	}
	select {
	case <-messages:
		t.Fatal("pack exceeded its receive window")
	case <-time.After(20 * time.Millisecond):
	}
}
