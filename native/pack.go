// SPDX-License-Identifier: GPL-3.0-only
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const maxPackBytes = 512 * 1024 * 1024

func packURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || len(value) > 4096 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return nil, fmt.Errorf("resource packs require a public HTTPS URL")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	for _, suffix := range []string{"localhost", "local", "internal", "lan", "home", "home.arpa", "onion"} {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return nil, fmt.Errorf("private resource-pack hosts are forbidden")
		}
	}
	if host == "metadata" || host == "instance-data" {
		return nil, fmt.Errorf("private resource-pack hosts are forbidden")
	}
	if ip, err := netip.ParseAddr(host); err == nil && !publicPackIP(ip) {
		return nil, fmt.Errorf("private resource-pack hosts are forbidden")
	}
	u.Fragment = ""
	return u, nil
}

func publicPackIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		if netip.MustParsePrefix(cidr).Contains(ip) {
			return false
		}
	}
	return true
}

func packClient() *http.Client {
	transport := &http.Transport{ResponseHeaderTimeout: 15 * time.Second, TLSHandshakeTimeout: 10 * time.Second,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil || port != "443" {
				return nil, fmt.Errorf("invalid resource-pack target")
			}
			ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
			if err != nil || len(ips) == 0 {
				return nil, fmt.Errorf("resource-pack host lookup failed")
			}
			for _, ip := range ips {
				if !publicPackIP(ip) {
					return nil, fmt.Errorf("private resource-pack addresses are forbidden")
				}
			}
			dialer := net.Dialer{Timeout: 10 * time.Second}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
		}}
	return &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 3 {
			return fmt.Errorf("too many resource-pack redirects")
		}
		_, err := packURL(req.URL.String())
		return err
	}}
}

func (p *pipe) runPack(client *http.Client) {
	defer p.close()
	ctx, cancel := context.WithTimeout(p.ctx, 180*time.Second)
	defer cancel()
	send := func(value any) error {
		b, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return p.send(true, b)
	}
	fail := func(message string) { _ = send(map[string]string{"error": message}) }
	var first wireMessage
	select {
	case first = <-p.in:
		p.queued.Add(-int64(len(first.data)))
	case <-ctx.Done():
		return
	}
	var request struct {
		URL             string `json:"url"`
		FollowRedirects *bool  `json:"followRedirects"`
	}
	if !first.text || json.Unmarshal(first.data, &request) != nil {
		fail("Invalid resource-pack request")
		return
	}
	u, err := packURL(request.URL)
	if err != nil {
		fail(err.Error())
		return
	}
	if client == nil {
		client = packClient()
	}
	defer client.CloseIdleConnections()
	if request.FollowRedirects != nil && !*request.FollowRedirects {
		copy := *client
		copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		client = &copy
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		fail("Invalid resource-pack request")
		return
	}
	req.Header.Set("Accept", "application/zip,application/octet-stream,*/*")
	req.Header.Set("User-Agent", "Minecraft Java (minecraft.wasm.click)")
	response, err := client.Do(req)
	if err != nil {
		fail("Resource-pack host could not be reached")
		return
	}
	defer response.Body.Close()
	if request.FollowRedirects != nil && !*request.FollowRedirects && (response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303 || response.StatusCode == 307 || response.StatusCode == 308) {
		fail("Resource-pack redirect refused")
		return
	}
	if response.ContentLength > maxPackBytes {
		fail("Resource pack exceeds 512 MiB")
		return
	}
	if err := send(map[string]int{"status": response.StatusCode}); err != nil {
		return
	}
	var total int64
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-p.in:
			p.queued.Add(-int64(len(message.data)))
			var command struct {
				Pull   json.RawMessage
				Cancel bool
			}
			if !message.text || json.Unmarshal(message.data, &command) != nil {
				fail("Invalid resource-pack pull")
				return
			}
			if command.Cancel {
				return
			}
			count := 0
			if string(command.Pull) == "true" {
				count = 1
			} else {
				_ = json.Unmarshal(command.Pull, &count)
			}
			if count < 1 || count > 8 {
				fail("Invalid resource-pack pull")
				return
			}
			for i := 0; i < count; i++ {
				chunk := make([]byte, 32768)
				n, err := io.ReadFull(response.Body, chunk)
				total += int64(n)
				if total > maxPackBytes {
					fail("Resource pack exceeds 512 MiB")
					return
				}
				if n > 0 && p.send(false, chunk[:n]) != nil {
					return
				}
				if err == io.EOF || err == io.ErrUnexpectedEOF {
					_ = send(map[string]bool{"eof": true})
					return
				}
				if err != nil {
					fail("Resource-pack download interrupted")
					return
				}
			}
		}
	}
}
