# Android x86_64: modernc's syscall shim, patched

The engine's SQLite is `modernc.org/sqlite`, pure Go over a transpiled musl
(`modernc.org/libc`). On **x86_64**, musl still issues the legacy syscalls the
architecture defines (`fstatat` fast-paths through `lstat`; `access`, `open`,
`unlink`, `mkdir`, … likewise). **Android's app seccomp filter** only allows
what bionic uses (the `*at` family) and kills anything else with SIGSYS, so
the stock engine dies on its first `lstat`. arm64 never had legacy syscalls,
so the phone build needs none of this.

Every musl syscall goes through one 90-line file, `syscall_musl.go`. This
directory holds a copy of it (`syscall_musl.go.overlay`) whose only change is
`androidCompat`, which rewrites each legacy call into its kernel-equivalent
`*at` call before it is made.

- `build-amd64.sh <out>` builds the x86_64 engine against a temporary copy of
  the module with the file swapped in (through `-modfile` and a `replace`).
  Go won't overlay files in the module cache, and the repository's `go.mod`
  stays untouched.
- `BASE_SHA256` pins the upstream file the patch was derived from. The script
  refuses to build if a modernc upgrade changed it. When that happens,
  re-derive the overlay from the new file (it's the original plus the marked
  CountRoster section) and update the hash.
- `../seccomp_linux_amd64_test.go` proves it on any Linux x86_64 box with
  `COUNTROSTER_SECCOMP_TEST=1`. A seccomp filter trapping those syscalls
  stands in for Android's: the stock engine must die under it, and the
  patched one must do real work (CRUD, backup restore, a sync round trip).

Not built into any other binary: the server and the arm64 engine use the
module unmodified.
