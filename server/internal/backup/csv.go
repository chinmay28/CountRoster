package backup

import (
	"strings"

	"github.com/chinmay28/countroster/server/internal/jsjson"
)

// rowsToCSV is a minimal RFC-4180 writer matching the TS exporter: fields
// containing a comma, quote, CR or LF are quoted with doubled quotes; rows
// join with CRLF; null renders empty; numbers render in JS formatting.
func rowsToCSV(columns []string, rows []*jsjson.Obj) string {
	lines := make([]string, 0, len(rows)+1)
	header := make([]string, len(columns))
	for i, c := range columns {
		header[i] = encodeCSVField(c)
	}
	lines = append(lines, strings.Join(header, ","))
	for _, row := range rows {
		fields := make([]string, len(columns))
		for i, c := range columns {
			fields[i] = encodeCSVField(row.Get(c))
		}
		lines = append(lines, strings.Join(fields, ","))
	}
	return strings.Join(lines, "\r\n")
}

func encodeCSVField(value any) string {
	var s string
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		s = v
	case float64:
		s = jsjson.NumberString(v)
	case bool:
		if v {
			s = "true"
		} else {
			s = "false"
		}
	default:
		return ""
	}
	if strings.ContainsAny(s, "\",\r\n") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}
