//go:build linux && (amd64 || arm64)

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/chinmay28/countroster/server/internal/stack"
)

// Android runs every app — and anything it execs — under a seccomp filter
// that allows only the syscalls its policy lists and kills the rest with
// SIGSYS. These tests run the engine under that exact allowlist
// (android_policy_test.go, generated from bionic's policy inputs in
// testdata/bionic), so a Linux box stands in for a phone:
//
//   - on x86_64 the stock engine must die (proving the stand-in is faithful:
//     modernc's musl makes legacy syscalls there) and the engine built by
//     androidlibc/build-amd64.sh must do real work;
//   - on arm64 the engine must do real work as built. Point
//     COUNTROSTER_SECCOMP_ENGINE at the android/arm64 artifact itself to
//     test exactly what ships (CI does, on an arm64 runner).
//
// Opt-in — it builds the engine — with COUNTROSTER_SECCOMP_TEST=1.

const helperEnv = "COUNTROSTER_SECCOMP_EXEC"

// TestSeccompHelper is not a test: re-run as a child process, it installs the
// filter on its own thread and execs the engine, which inherits it.
func TestSeccompHelper(t *testing.T) {
	bin := os.Getenv(helperEnv)
	if bin == "" {
		t.Skip("helper process only")
	}
	runtime.LockOSThread()
	if err := installAndroidFilter(); err != nil {
		fmt.Fprintln(os.Stderr, "seccomp:", err)
		os.Exit(3)
	}
	args := append([]string{bin}, strings.Fields(os.Getenv(helperEnv+"_ARGS"))...)
	err := syscall.Exec(bin, args, os.Environ())
	fmt.Fprintln(os.Stderr, "exec:", err)
	os.Exit(3)
}

func installAndroidFilter() error {
	const (
		ldAbs = unix.BPF_LD | unix.BPF_W | unix.BPF_ABS
		jeqK  = unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K
		retK  = unix.BPF_RET | unix.BPF_K
		allow = unix.SECCOMP_RET_ALLOW
		trap  = unix.SECCOMP_RET_TRAP // SIGSYS, as Android does
	)
	arch := map[string]uint32{"amd64": unix.AUDIT_ARCH_X86_64, "arm64": unix.AUDIT_ARCH_AARCH64}[runtime.GOARCH]
	f := []unix.SockFilter{
		{Code: ldAbs, K: 4}, // seccomp_data.arch: anything else is refused
		{Code: jeqK, Jt: 1, Jf: 0, K: arch},
		{Code: retK, K: trap},
		{Code: ldAbs, K: 0}, // seccomp_data.nr
	}
	for _, nr := range androidAppAllowlist[runtime.GOARCH] {
		f = append(f, unix.SockFilter{Code: jeqK, Jt: 0, Jf: 1, K: nr},
			unix.SockFilter{Code: retK, K: allow})
	}
	f = append(f, unix.SockFilter{Code: retK, K: trap})

	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	prog := unix.SockFprog{Len: uint16(len(f)), Filter: &f[0]}
	if _, _, e := unix.Syscall(unix.SYS_PRCTL, unix.PR_SET_SECCOMP,
		unix.SECCOMP_MODE_FILTER, uintptr(unsafe.Pointer(&prog))); e != 0 {
		return e
	}
	return nil
}

// underAndroidFilter starts bin as the Android shell would, but inside the
// filter. It returns the engine's port, or the reason it died.
func underAndroidFilter(t *testing.T, bin, dataDir string) (port int, stdin io.WriteCloser, died string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestSeccompHelper$")
	cmd.Env = append(os.Environ(),
		helperEnv+"="+bin,
		helperEnv+"_ARGS=--data-dir "+dataDir+" --tz America/Los_Angeles",
		SecretEnv+"="+secret,
		"TMPDIR="+t.TempDir(),
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, _ := cmd.StdoutPipe()
	stdin, _ = cmd.StdinPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); cmd.Wait() })

	lines := make(chan string)
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				cmd.Wait()
				return 0, stdin, fmt.Sprintf("%v: %s", cmd.ProcessState, firstLines(stderr.String(), 3))
			}
			if payload, ok := strings.CutPrefix(line, ReadyPrefix); ok {
				var r struct{ Port int }
				json.Unmarshal([]byte(payload), &r)
				return r.Port, stdin, ""
			}
		case <-time.After(30 * time.Second):
			t.Fatal("engine neither started nor died")
		}
	}
}

func firstLines(s string, n int) string {
	parts := strings.SplitN(s, "\n", n+1)
	return strings.Join(parts[:min(n, len(parts))], " | ")
}

func requireSeccompTest(t *testing.T) {
	if os.Getenv("COUNTROSTER_SECCOMP_TEST") != "1" {
		t.Skip("set COUNTROSTER_SECCOMP_TEST=1 (builds the engine twice)")
	}
}

// buildEngine builds the engine for this host. patched selects the x86_64
// build with the syscall shim; on arm64 there is nothing to patch.
func buildEngine(t *testing.T, patched bool) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "engine")
	var cmd *exec.Cmd
	if patched && runtime.GOARCH == "amd64" {
		cmd = exec.Command("./androidlibc/build-amd64.sh", out)
	} else {
		cmd = exec.Command("go", "build", "-trimpath", "-o", out, ".")
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux")
	}
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build (patched=%v): %v\n%s", patched, err, b)
	}
	return out
}

// engineUnderTest is the shipping engine: COUNTROSTER_SECCOMP_ENGINE when
// set (e.g. the android/arm64 artifact), else a fresh build.
func engineUnderTest(t *testing.T) string {
	if bin := os.Getenv("COUNTROSTER_SECCOMP_ENGINE"); bin != "" {
		abs, err := filepath.Abs(bin)
		if err != nil {
			t.Fatal(err)
		}
		return abs
	}
	return buildEngine(t, true)
}

func TestUnpatchedEngineDiesUnderAndroidsFilter(t *testing.T) {
	requireSeccompTest(t)
	if runtime.GOARCH != "amd64" {
		t.Skip("only x86_64 has the legacy syscalls the patch removes")
	}
	bin := buildEngine(t, false)
	if port, _, died := underAndroidFilter(t, bin, t.TempDir()); port != 0 {
		t.Fatal("the unpatched engine survived — the filter isn't standing in for Android's")
	} else {
		t.Logf("died as on Android: %s", died)
	}
}

func TestShippingEngineWorksUnderAndroidsFilter(t *testing.T) {
	requireSeccompTest(t)
	bin := engineUnderTest(t)
	dataDir := t.TempDir()
	port, _, died := underAndroidFilter(t, bin, dataDir)
	if port == 0 {
		t.Fatalf("patched engine died: %s", died)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	call := func(method, path string, body []byte, ctype string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+secret)
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v (engine killed?)", method, path, err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, b
	}
	jsonCall := func(method, path, body string, want int) []byte {
		t.Helper()
		status, b := call(method, path, []byte(body), "application/json")
		if status != want {
			t.Fatalf("%s %s = %d, want %d: %s", method, path, status, want, b)
		}
		return b
	}

	// Ordinary use: trackers, entries, notes, stats.
	var tr struct{ ID string }
	json.Unmarshal(jsonCall("POST", "/api/trackers", `{"name":"Water","kind":"count"}`, 201), &tr)
	jsonCall("POST", "/api/trackers/"+tr.ID+"/entries", `{"value":3}`, 201)
	jsonCall("POST", "/api/notes", `{"tracker_id":"`+tr.ID+`","body":"hi"}`, 201)
	jsonCall("GET", "/api/trackers/"+tr.ID+"/stats/streak", "", 200)

	// Backups: export, then restore over the live database.
	status, bundle := call("GET", "/api/backup/bundle", nil, "")
	if status != 200 || len(bundle) == 0 {
		t.Fatalf("export = %d", status)
	}
	status, b := call("POST", "/api/backup/import?confirmOverwrite=1", bundle, "application/zip")
	if status != 200 {
		t.Fatalf("import = %d %s", status, b)
	}
	status, _ = call("GET", "/api/backup/sqlite", nil, "")
	if status != 200 {
		t.Fatalf("raw sqlite download = %d", status)
	}

	// Sync there and back: safety bundles, a proxied API, a copied database.
	remote, err := stack.Open(stack.Options{DBPath: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	srv := httptest.NewServer(remote.API)
	defer srv.Close()
	jsonCall("POST", "/_engine/sync/enable", `{"url":"`+srv.URL+`","strategy":"use_server"}`, 200)
	jsonCall("POST", "/api/trackers", `{"name":"Synced","kind":"count"}`, 201)
	jsonCall("POST", "/_engine/sync/disable", `{"strategy":"copy_from_server"}`, 200)
	if got := string(jsonCall("GET", "/api/trackers", "", 200)); !strings.Contains(got, "Synced") {
		t.Errorf("copied database missing the synced tracker: %s", got)
	}
}
