package engine

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sync/atomic"
)

// DNS is a resolver whose upstream servers are supplied from outside.
//
// A cgo-free Go binary on Android has no working resolver: the pure-Go one
// reads /etc/resolv.conf, which Android doesn't have, and falls back to
// 127.0.0.1:53 (golang/go#10714). The native shell knows the active
// network's DNS servers (including a VPN's, e.g. Tailscale's 100.100.100.100)
// and pushes them here whenever they change.
type DNS struct {
	servers atomic.Pointer[[]string]
	next    atomic.Uint32
	dialer  net.Dialer
	port    uint16 // 0 is 53; tests point it elsewhere
}

// Set replaces the upstream servers. Each must be an IP address, optionally
// with a zone ("fe80::1%wlan0"); an empty list restores Go's default.
func (d *DNS) Set(servers []string) error {
	out := make([]string, 0, len(servers))
	for _, s := range servers {
		addr, err := netip.ParseAddr(s)
		if err != nil {
			return fmt.Errorf("dns server %q: not an IP address", s)
		}
		port := d.port
		if port == 0 {
			port = 53
		}
		out = append(out, netip.AddrPortFrom(addr, port).String())
	}
	d.servers.Store(&out)
	return nil
}

// Servers returns the current upstream servers as host:port.
func (d *DNS) Servers() []string {
	if p := d.servers.Load(); p != nil {
		return append([]string(nil), (*p)...)
	}
	return []string{}
}

// Resolver returns a pure-Go resolver dialing the current servers, rotating
// between them per query so one dead server doesn't sink every lookup.
// With no servers set it dials whatever Go asked for.
func (d *DNS) Resolver() *net.Resolver {
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			if servers := d.Servers(); len(servers) > 0 {
				address = servers[int(d.next.Add(1)-1)%len(servers)]
			}
			return d.dialer.DialContext(ctx, network, address)
		},
	}
}
