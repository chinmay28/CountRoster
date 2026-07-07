// Package ids generates UUIDv7 strings (RFC 9562). v7 IDs are
// timestamp-prefixed so they sort by creation time — the domain relies on
// that for stable list ordering and same-instant tie-breaks (ORDER BY id).
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

var (
	mu      sync.Mutex
	lastMS  int64
	counter uint16 // 12-bit monotonic sequence within one millisecond
)

// New returns a UUIDv7 string. Within a single millisecond IDs stay
// monotonic via a 12-bit counter in rand_a, matching the npm `uuidv7`
// package's behavior that the tie-break ordering in SQL depends on.
func New() string {
	var b [16]byte
	if _, err := rand.Read(b[6:]); err != nil {
		panic(err)
	}

	mu.Lock()
	ms := time.Now().UnixMilli()
	if ms <= lastMS {
		ms = lastMS
		counter++
		if counter > 0x0fff {
			// Counter overflow: nudge into the next millisecond.
			ms++
			counter = 0
		}
	} else {
		counter = uint16(b[6])<<8 | uint16(b[7])&0x0fff
		counter &= 0x0fff
	}
	lastMS = ms
	seq := counter
	mu.Unlock()

	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = 0x70 | byte(seq>>8)&0x0f // version 7 + counter high bits
	b[7] = byte(seq)                // counter low bits
	b[8] = 0x80 | b[8]&0x3f         // RFC 4122 variant

	var out [36]byte
	hex.Encode(out[0:8], b[0:4])
	out[8] = '-'
	hex.Encode(out[9:13], b[4:6])
	out[13] = '-'
	hex.Encode(out[14:18], b[6:8])
	out[18] = '-'
	hex.Encode(out[19:23], b[8:10])
	out[23] = '-'
	hex.Encode(out[24:36], b[10:16])
	return string(out[:])
}
