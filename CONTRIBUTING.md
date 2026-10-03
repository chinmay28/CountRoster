# Contributing to CountRoster

Thanks for wanting to contribute! Please read this before opening a pull
request.

## License and the CLA

CountRoster is licensed under the **GNU Affero General Public License v3.0**
(`AGPL-3.0-only`). See [`LICENSE`](./LICENSE).

Contributions are made under the [Contributor License Agreement](./CLA.md).
In short: you keep ownership of your work, but you grant the maintainer a broad
license, including the right to relicense your contribution under other terms.
That covers a commercial or dual licence, and distribution through app stores
such as Apple's, whose terms the AGPL doesn't allow. [LICENSING.md](./LICENSING.md)
explains why. If you are contributing on behalf of an employer, make sure you
have the right to do so.

**Sign the CLA once.** On your first pull request a bot asks you to accept it.
Reply with a comment containing exactly:

```
I have read the CLA Document and I hereby sign the CLA
```

It records the signature (`.github/workflows/cla.yml`) and covers all your
future contributions.

**Dependencies must be permissive.** A pull request that adds a dependency
under GPL, LGPL, AGPL, MPL or an unrecognized licence fails the licence check
(`node scripts/licenses.mjs check`). Third-party code can't be relicensed, so
it would block the dual licence.

## Signing off your commits (DCO)

Add a `Signed-off-by` line to **every** commit, certifying the
[Developer Certificate of Origin](https://developercertificate.org/).
The easiest way is to commit with the `-s` flag:

```bash
git commit -s -m "Your message"
```

This appends a line like:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match your real identity and your git configuration
(`git config user.name` / `git config user.email`).

A CI check (`.github/workflows/dco.yml`) verifies that **every** commit in a pull
request is signed off, and the PR cannot merge until it passes. If you forgot,
sign off your existing commits in one go:

```bash
git rebase --signoff <base-branch>   # e.g. origin/main
git push --force-with-lease
```

## Development

See [`CLAUDE.md`](./CLAUDE.md) and [`DESIGN.md`](./DESIGN.md) for architecture,
[`server/README.md`](./server/README.md) for the Go backend, and
[`apps/web/README.md`](./apps/web/README.md) for the PWA client. Before opening
a PR:

```bash
npm install        # Node >= 20.10 (web build tooling); Go >= 1.21 for the server
npm run build      # TS workspaces + `go build` the server binary
npm test           # vitest (web/core) + `go test ./...` (server domain & API)
npm run typecheck  # tsc --noEmit + `go vet`
```

TypeScript strict mode and `go vet` are the static-analysis gates; there is no
separate linter.

## Pull requests

- Keep changes focused and described clearly.
- Add or update tests for behavior changes (server behavior: `server/internal/**/*_test.go`; web components: `apps/web/src/**/*.test.tsx`).
- Make sure `npm test` and `npm run typecheck` pass.
- Ensure every commit is signed off (see above).
