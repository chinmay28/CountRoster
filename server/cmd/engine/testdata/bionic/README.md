# Android's seccomp policy inputs (bionic)

Verbatim copies of the files AOSP's `genseccomp.py` builds the **app**
seccomp policy from (the filter on every zygote-spawned process, i.e. every
app and anything it execs):

    SYSCALLS.TXT  SECCOMP_ALLOWLIST_COMMON.TXT  SECCOMP_ALLOWLIST_APP.TXT
    SECCOMP_BLOCKLIST_COMMON.TXT  SECCOMP_BLOCKLIST_APP.TXT  SECCOMP_PRIORITY.TXT

Source: https://android.googlesource.com/platform/bionic/+/refs/heads/main/libc/
(fetched from the aosp-mirror/platform_bionic GitHub mirror, `main`, on
2026-10-03). Licensed Apache-2.0 by the Android Open Source Project.

`../gen_android_policy.go` turns them into `../../android_policy_test.go`.
That is the allowlist the engine's seccomp test runs under: allowed =
syscalls + allowlists + priority − blocklists, everything else traps with
SIGSYS, as on a phone. To refresh, replace these files and run
`go run ./cmd/engine/testdata/gen_android_policy.go` from `server/`.
