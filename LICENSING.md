# Licensing

## The short version

- **CountRoster is free software under the GNU Affero General Public License
  v3.0** (`AGPL-3.0-only`, see [LICENSE](./LICENSE)). You may use, study,
  change and share it on those terms, including §13: if you run a modified
  version for other people over a network, offer them its source.
- **The maintainer also distributes CountRoster under other terms.** As the
  copyright holder, with every contributor's grant under the
  [CLA](./CLA.md), the maintainer may publish builds whose terms the AGPL
  doesn't allow. The App Store is the concrete case: Apple's terms restrict
  recipients in ways AGPL §10 forbids, so an iOS app can only ship that way.
  Those builds don't change your rights to the AGPL source.
- **The name and logo aren't licensed under the AGPL.** See below.

## Why it's set up this way

A licence binds the people who *receive* the code, not the people who own it.
The maintainer can therefore ship the project's own code under any terms, but
only code the project owns. Three things keep that true:

1. **The CLA.** Contributors keep ownership of their work and grant the
   maintainer (and successors) the right to relicense it, app stores
   included. Each contributor signs once, on their first pull request
   (`.github/workflows/cla.yml`). Every commit also carries a DCO
   `Signed-off-by` (`.github/workflows/dco.yml`).
2. **Permissive dependencies only.** Third-party code can't be relicensed, so
   anything that ships must be under a permissive licence (MIT, BSD, ISC,
   Apache-2.0, …). Copyleft dependencies (GPL, LGPL, AGPL, MPL) are refused.
   `scripts/licenses.mjs check` enforces this across the Go binaries, the web
   client's npm packages and the Android shell's Gradle dependencies, in CI
   (`.github/workflows/licenses.yml`) and in every app build.
3. **Notices travel with every build.** Permissive licences still require
   their text to accompany the software. The build writes
   `third-party-notices.txt` into the web client, and the Data page links it,
   in the PWA and in the apps alike.

Builds distributed under other terms still come from this public source, and
the maintainer intends to keep publishing it.

## Name and logo

"CountRoster" and its logo identify the maintainer's builds. The AGPL covers
the code, not the name. You're welcome to fork, but a fork that's distributed
or offered as a service must use a different name and icon, so nobody
mistakes it for the original. Saying your project is "based on CountRoster"
is fine.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md): sign off every commit, and sign the
CLA once when the bot asks on your first pull request.

*This page explains the project's intent; it isn't legal advice, and the
[LICENSE](./LICENSE) and [CLA](./CLA.md) texts govern.*
