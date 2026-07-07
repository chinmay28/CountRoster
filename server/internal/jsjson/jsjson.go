// Package jsjson serializes and parses JSON byte-identically to JavaScript's
// JSON.stringify / JSON.parse.
//
// The backup manifest's checksum is SHA-256 over JSON.stringify(tables) as
// produced by the original TypeScript core. For bundles to round-trip between
// the two implementations, this package must reproduce ECMAScript semantics
// exactly: object keys in insertion order, Number::toString formatting
// (shortest round-trip digits, exponent notation only for |x| ≥ 1e21 or
// < 1e-6), and JSON.stringify's minimal string escaping.
package jsjson

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Obj is a JSON object with insertion-ordered keys.
type Obj struct {
	keys   []string
	values map[string]any
}

// NewObj returns an empty ordered object.
func NewObj() *Obj {
	return &Obj{values: map[string]any{}}
}

// Set adds or replaces a key. A new key is appended to the order, matching
// JS object insertion semantics.
func (o *Obj) Set(key string, v any) {
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = v
}

// Get returns the value for key (nil if absent).
func (o *Obj) Get(key string) any { return o.values[key] }

// Has reports whether key is present.
func (o *Obj) Has(key string) bool {
	_, ok := o.values[key]
	return ok
}

// Keys returns the insertion-ordered key list.
func (o *Obj) Keys() []string { return o.keys }

// Len returns the number of keys.
func (o *Obj) Len() int { return len(o.keys) }

// Stringify renders v like JSON.stringify(v). Supported values: nil, bool,
// string, float64, int, int64, *Obj, []any.
func Stringify(v any) []byte {
	var b strings.Builder
	writeValue(&b, v, -1, 0)
	return []byte(b.String())
}

// StringifyIndent renders v like JSON.stringify(v, null, indent).
func StringifyIndent(v any, indent int) []byte {
	var b strings.Builder
	writeValue(&b, v, indent, 0)
	return []byte(b.String())
}

func writeValue(b *strings.Builder, v any, indent, depth int) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeString(b, t)
	case float64:
		b.WriteString(NumberString(t))
	case int:
		b.WriteString(NumberString(float64(t)))
	case int64:
		b.WriteString(NumberString(float64(t)))
	case *Obj:
		writeObj(b, t, indent, depth)
	case []any:
		writeArr(b, t, indent, depth)
	default:
		panic(fmt.Sprintf("jsjson: unsupported type %T", v))
	}
}

func writeObj(b *strings.Builder, o *Obj, indent, depth int) {
	if len(o.keys) == 0 {
		b.WriteString("{}")
		return
	}
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		newlineIndent(b, indent, depth+1)
		writeString(b, k)
		b.WriteByte(':')
		if indent >= 0 {
			b.WriteByte(' ')
		}
		writeValue(b, o.values[k], indent, depth+1)
	}
	newlineIndent(b, indent, depth)
	b.WriteByte('}')
}

func writeArr(b *strings.Builder, arr []any, indent, depth int) {
	if len(arr) == 0 {
		b.WriteString("[]")
		return
	}
	b.WriteByte('[')
	for i, v := range arr {
		if i > 0 {
			b.WriteByte(',')
		}
		newlineIndent(b, indent, depth+1)
		writeValue(b, v, indent, depth+1)
	}
	newlineIndent(b, indent, depth)
	b.WriteByte(']')
}

func newlineIndent(b *strings.Builder, indent, depth int) {
	if indent < 0 {
		return
	}
	b.WriteByte('\n')
	for i := 0; i < indent*depth; i++ {
		b.WriteByte(' ')
	}
}

const hexDigits = "0123456789abcdef"

// writeString escapes exactly like ECMA-262 QuoteJSONString: the two-char
// escapes for \" \\ \b \f \n \r \t, \u00xx for remaining control chars, and
// everything else emitted literally as UTF-8 (JS does not escape U+2028/29
// or non-ASCII in JSON.stringify).
func writeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[r>>4])
				b.WriteByte(hexDigits[r&0xf])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// NumberString formats f exactly like ECMAScript Number::toString(10) —
// which is also what JSON.stringify emits for finite numbers. (JSON.stringify
// turns non-finite numbers into null; callers handle that before calling.)
func NumberString(f float64) string {
	if f == 0 {
		return "0" // covers -0 too: JSON.stringify(-0) === "0"
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	neg := ""
	if f < 0 {
		neg = "-"
		f = -f
	}

	// Shortest round-trip digits and decimal exponent via strconv's 'e'
	// formatting: "d.ddde±dd" → digits, exp10 (f = 0.digits × 10^n, n = exp10+1).
	mant := strconv.FormatFloat(f, 'e', -1, 64)
	eIdx := strings.IndexByte(mant, 'e')
	exp10, _ := strconv.Atoi(mant[eIdx+1:])
	digits := mant[:1]
	if len(mant) > 2 && mant[1] == '.' {
		digits += mant[2:eIdx]
	}
	k := len(digits)
	n := exp10 + 1

	switch {
	case k <= n && n <= 21:
		return neg + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return neg + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return neg + "0." + strings.Repeat("0", -n) + digits
	default:
		expPart := strconv.Itoa(n - 1)
		if n-1 >= 0 {
			expPart = "+" + expPart
		}
		if k == 1 {
			return neg + digits + "e" + expPart
		}
		return neg + digits[:1] + "." + digits[1:] + "e" + expPart
	}
}

// Parse decodes JSON preserving object key order (as *Obj) and converting
// numbers to float64 with JS semantics (precision loss beyond 2^53 included,
// matching JSON.parse). Arrays decode as []any, strings as string, etc.
func Parse(data []byte) (any, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	// Reject trailing content.
	if _, err := dec.Token(); err == nil {
		return nil, errors.New("jsjson: trailing data after JSON value")
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return parseFromToken(dec, tok)
}

func parseFromToken(dec *json.Decoder, tok json.Token) (any, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := NewObj()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, errors.New("jsjson: object key is not a string")
				}
				val, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				obj.Set(key, val)
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				val, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, val)
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("jsjson: unexpected delimiter %v", t)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return nil, err
		}
		return f, nil
	case string, bool, nil:
		return t, nil
	}
	return nil, fmt.Errorf("jsjson: unexpected token %v", tok)
}

// Valid UTF-8 guard used by tests; SQLite TEXT written by this app is always
// valid UTF-8, and writeString assumes it.
func validUTF8(s string) bool { return utf8.ValidString(s) }
