package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/chinmay28/countroster/server/internal/api"
)

const secret = "0123456789abcdef0123456789abcdef"

// launch starts the engine the way the Android shell does and returns its
// port plus the stdin pipe whose closing stops it.
func launch(t *testing.T, args ...string) (port int, stdin *io.PipeWriter, done <-chan error) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	errc := make(chan error, 1)
	env := func(k string) string {
		if k == SecretEnv {
			return secret
		}
		return ""
	}
	go func() {
		errc <- run(context.Background(), args, env, inR, outW, log.New(io.Discard, "", 0))
		outW.Close()
	}()
	line, err := bufio.NewReader(outR).ReadString('\n')
	if err != nil {
		t.Fatalf("no ready line: %v (%v)", err, <-errc)
	}
	go io.Copy(io.Discard, outR)
	payload, ok := strings.CutPrefix(strings.TrimSpace(line), ReadyPrefix)
	if !ok {
		t.Fatalf("ready line %q", line)
	}
	var ready struct {
		Port     int    `json:"port"`
		Version  string `json:"version"`
		APILevel int    `json:"api_level"`
	}
	if err := json.Unmarshal([]byte(payload), &ready); err != nil || ready.Port == 0 ||
		ready.APILevel != api.APILevel || ready.Version == "" {
		t.Fatalf("ready payload %q", payload)
	}
	return ready.Port, inW, errc
}

func TestLauncherContract(t *testing.T) {
	dir := t.TempDir()
	port, stdin, done := launch(t, "--data-dir", dir, "--tz", "America/Los_Angeles", "--dns", "100.100.100.100")
	base := "http://127.0.0.1:" + strconv.Itoa(port)

	req, _ := http.NewRequest("POST", base+"/api/trackers", strings.NewReader(`{"name":"Water","kind":"count"}`))
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var tr struct {
		CreatedAt string `json:"created_at"`
	}
	json.NewDecoder(res.Body).Decode(&tr)
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("create = %d", res.StatusCode)
	}
	// The --tz zone governs local timestamps, not Android's UTC default.
	la, _ := time.LoadLocation("America/Los_Angeles")
	if want := time.Now().In(la).Format("-07:00"); !strings.HasSuffix(tr.CreatedAt, want) {
		t.Errorf("created_at %q not in the --tz zone (%s)", tr.CreatedAt, want)
	}

	// Without the secret: nothing.
	res, err = http.Get(base + "/api/trackers")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Errorf("anonymous = %d", res.StatusCode)
	}

	// Closing stdin — the parent going away — stops the engine.
	stdin.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("exit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("engine outlived its stdin")
	}
}

func TestLauncherRejectsBadInvocations(t *testing.T) {
	env := func(string) string { return "" }
	for _, args := range [][]string{
		{},                               // no --data-dir
		{"--data-dir", t.TempDir()},      // no secret in the environment
		{"--data-dir", t.TempDir(), "x"}, // stray argument
		{"--data-dir", t.TempDir(), "--dns", "dns.google"},
	} {
		err := run(context.Background(), args, env, strings.NewReader(""), io.Discard, log.New(io.Discard, "", 0))
		if err == nil {
			t.Errorf("run(%v) succeeded", args)
		}
	}
}
