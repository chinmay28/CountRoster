package engine

import (
	"encoding/json"
	"net/http"
)

// writeJSON and writeError follow the /api conventions (snake_case, an
// {"error": …} body), so the web client reads /_engine like the rest.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
