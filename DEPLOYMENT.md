# countroster — Deployment Guide

This document covers shipping the three apps the project will eventually have:
**iOS** to the App Store, **Android** to the Play Store, and the **desktop web app**
to a static host. It assumes the architecture from [`DESIGN.md`](./DESIGN.md) —
local-first, no backend, SQLite on every device.

> As of this writing, `apps/mobile` and `apps/web` are not yet scaffolded — only
> `@countroster/core` exists. The instructions below describe the deployment path each
> app will take once scaffolded, and are written so you can use them as soon as
> the platform shells are in place.

## 1. What's actually being deployed

Because the app is local-first, the deployment story is unusually simple:

- **No server to host, no database to provision, no auth provider to wire up.**
- **No environment variables for production secrets** — there are no secrets.
- **No backwards-compatible API contracts to maintain** across app versions —
  the only on-the-wire format is the backup file, versioned by `schema_version`
  in `manifest.json` (see DESIGN §6.4, §8).

What does get deployed:

| Artifact            | Goes to                  | Cadence             |
|---------------------|--------------------------|---------------------|
| iOS `.ipa`          | App Store Connect → App Store | Per release |
| Android `.aab`      | Google Play Console → Play Store | Per release |
| Web static bundle   | Static host (Vercel / Cloudflare / etc.) | Per push to `main` |
| EAS Update payload  | Expo's CDN (optional)    | JS-only patches between native releases |

## 2. Costs at a glance

| Item                              | Cost (2026)                | Type             |
|-----------------------------------|----------------------------|------------------|
| Apple Developer Program           | $99/year                   | Recurring        |
| Google Play Console               | $25                        | One-time         |
| EAS Build Free tier               | $0 — 15 iOS + 15 Android builds/month | Free up to limit |
| EAS Build Starter (if needed)     | $19/month                  | Optional         |
| Web hosting (Vercel/Cloudflare/Netlify free tier) | $0     | Free for personal-scale traffic |
| Custom domain                     | ~$10-15/year               | Optional         |

For a one-developer personal project shipping at a normal cadence, total
recurring cost lands at about **$110/year** ($99 Apple + ~$15 domain). One-time
$25 to Google. Web hosting and EAS Build stay free.

> Verify current pricing at kickoff — the EAS tiers in particular shift
> frequently. Last checked May 2026: 15 iOS + 15 Android builds/month free,
> Starter at $19/mo unlocks priority queues and the 2-hour build timeout.

## 3. Prerequisites

### Accounts

- **Apple Developer account** (Organization or Individual). Individual is fine
  for a personal project. Pay $99/year. Sign up at developer.apple.com.
- **Google Play Console account.** $25 one-time. Sign up at play.google.com/console.
  Personal accounts are subject to the 12-tester closed-testing rule (see §5.4).
- **Expo account** for EAS Build / Submit / Update. Free.
- **Hosting account** for the web app (Vercel, Cloudflare, or whatever you pick).

### Toolchain

- Node 22+ (we already require this for `node:sqlite`).
- `eas-cli` installed globally: `npm install -g eas-cli`.
- A macOS machine is **not required** — EAS Build runs iOS builds remotely on
  Apple silicon machines. You will need a Mac for some niche workflows
  (running iOS Simulator locally, attaching Xcode for debugging native crashes,
  taking App Store screenshots through the Simulator). Most day-to-day work is
  Mac-free.
- A real iPhone and a real Android device for testing. The simulators help but
  some bugs only show up on hardware.

### Project identifiers — pick before you build anything

You will need these across all three platforms; pick once, never change:

- **Bundle ID / Application ID:** reverse-DNS style, e.g. `com.countroster.app`.
- **App name:** the user-visible name. This project ships as **CountRoster** —
  the original "Tally" iOS app is trademarked by Kodeon, Inc., and we picked
  a distinct name to avoid confusion. If you change this, do it before
  registering the Bundle ID with Apple or the Application ID with Google.
- **Display short name** (for the home screen).
- **Color scheme** for adaptive icons / splash.

## 4. iOS deployment

### 4.1 One-time setup

1. **Enroll in Apple Developer Program** (~24-48h for individual accounts to be
   approved; longer for organizations).

2. **Register your Bundle ID** in App Store Connect → Certificates, Identifiers
   & Profiles → Identifiers. Use the same Bundle ID you'll put in
   `apps/mobile/app.json`.

3. **Create the app record** in App Store Connect → My Apps → "+". Fill in name,
   primary language, Bundle ID, SKU. Save before continuing — you can't upload
   builds without an app record.

4. **Initialize EAS** in `apps/mobile`:

   ```bash
   cd apps/mobile
   eas login
   eas build:configure
   ```

   This writes `eas.json` with `development`, `preview`, and `production`
   build profiles.

5. **Let EAS manage your credentials** when prompted:

   ```bash
   eas credentials
   ```

   Choose "Generate new keychain entries" the first time. EAS will create and
   securely store your distribution certificate and provisioning profile. You
   never touch a `.p12` file by hand if you don't want to.

### 4.2 Production builds

```bash
eas build --platform ios --profile production
```

This kicks off a remote build on EAS's macOS infrastructure. Roughly 15-30
minutes; longer if the queue is busy on the free tier. Output: a signed `.ipa`
artifact downloadable from your EAS dashboard.

### 4.3 Submit to TestFlight (always do this first)

```bash
eas submit --platform ios --latest
```

`eas submit` uploads the `.ipa` to App Store Connect. After processing
(~10-30 min) the build appears in TestFlight. Add yourself as an internal tester
and install via the TestFlight app on your phone. Live with it for a few days
before promoting.

### 4.4 Promote to App Store

In App Store Connect:

1. Open the app record → "+ Version or Platform" → enter the version string
   (e.g. `0.1.0`).
2. Pick the TestFlight build you just uploaded.
3. Fill in metadata: screenshots (6.7" and 6.1" iPhone required), description,
   keywords, support URL, privacy URL, age rating.
4. **App Privacy section** — declare "Data Not Collected" since the app stores
   no data off-device. This is one of the rare apps where that answer is
   genuinely true and you should say so explicitly.
5. **Export Compliance** — when asked about encryption, the standard answer for
   a SQLite-only local app with HTTPS-only network use (the EAS Update channel)
   is that you qualify for the exemption.
6. Submit for review.

App Review for new apps typically takes 24-48 hours in 2026. First submissions
are scrutinized more closely; expect possible rejection for missing privacy
disclosures or screenshots that don't match what the reviewer sees. Iterate.

### 4.5 Ongoing releases

For each release:

```bash
eas build --platform ios --profile production --auto-submit
```

`--auto-submit` chains `build` and `submit`. Then in App Store Connect, attach
the new build to a new version record and submit for review.

JS-only patches (no native code change) can ship without a build:

```bash
eas update --branch production --message "Fix typo in settings screen"
```

The update reaches users the next time they open the app. Native code changes
require a fresh App Store submission.

## 5. Android deployment

### 5.1 One-time setup

1. **Sign up for Google Play Console**, pay $25.

2. **Identity verification.** Personal accounts now require verifying your real
   name and (in many regions) a government ID. This can take a few days.

3. **Initialize EAS** if you haven't already from §4.1.

4. **Generate the Android signing key** through EAS:

   ```bash
   eas credentials
   ```

   Pick Android → "Generate new keystore". EAS holds the keystore in their
   secure storage; download a local copy and back it up off-EAS too — losing
   this keystore means you can never publish updates to the same app and have
   to ship as a new app.

5. **Create the Play Console app record.** App name, default language,
   free/paid (Free), declarations.

6. **Set up the Service Account for `eas submit`** so EAS can push builds
   directly to the Play Console:
   - Play Console → Settings → API access → "Create new service account".
   - Follow the prompts to create a Google Cloud service account.
   - Download the JSON key. Save as `apps/mobile/play-service-account.json`.
   - Add to `eas.json` under the Android submit config.
   - **Do not commit this JSON.** Add it to `.gitignore`.

### 5.2 Production builds

```bash
eas build --platform android --profile production
```

Output: a signed `.aab` (Android App Bundle, Google's required format since
August 2021).

### 5.3 The 12-tester closed-test gate (personal accounts)

**Important:** if you opened your Play Console as a personal account on or after
November 13, 2023, you must run a Closed Test with **12 testers opted in for
14 consecutive days** before Google will unlock production access. Organization
accounts are exempt; older personal accounts are grandfathered.

The path is:

1. **Internal Testing** — up to 100 testers, builds available in seconds. Use
   this for yourself and friends.
2. **Closed Testing** — invite at least 12 people (real Android devices, not
   emulators) via a tester list or email. They must opt in and the app must
   remain installed for 14 continuous days.
3. After 14 days, Play Console unlocks "Apply for production access". Submit
   the application with the questionnaire about your app and testing process.
4. Once approved → **Production** track.

If you don't have 12 willing friends with Android phones, this gate can be
genuinely painful. Options:

- Recruit through r/AndroidAppTesting or similar communities (free, slow).
- Use a tester-matching service (~$15-30, fast but quality varies).
- Open a Google Play **Organization** account instead, which skips the
  requirement. Costs the same $25.

### 5.4 Submitting and releasing

For Internal/Closed/Open/Production tracks:

```bash
eas submit --platform android --latest --track internal
eas submit --platform android --latest --track production
```

In the Play Console, attach the uploaded build to a release on the target
track, write release notes, and roll out. Production rollouts can be
percentage-staged (start at 5%, watch crash rates, ramp up).

Review on Android is typically faster than iOS (hours, not days) once your
account has produced a production release.

### 5.5 Ongoing releases

```bash
eas build --platform android --profile production --auto-submit
```

JS-only patches via `eas update` work identically to iOS.

## 6. Web app deployment

### 6.1 Why this is the easy one

The web app is a fully static bundle: HTML + JS + CSS + the `sqlite-wasm`
binary. No server-side rendering with database calls, no API routes, no
runtime secrets. Build once, upload to any static host, done.

### 6.2 HTTPS is non-negotiable

The web app uses two browser APIs that require a secure context:

- **OPFS (Origin Private File System)** — for persisting the SQLite database
  across page loads.
- **File System Access API** — for letting users pick where backups land.

Both require HTTPS. `http://localhost` works for development; nothing else
does. Every hosting option below provides automatic HTTPS by default.

### 6.3 Build

Assuming Next.js with the static export configured (`output: 'export'` in
`next.config.js`):

```bash
cd apps/web
npm run build
# → produces apps/web/out/  (the deployable static bundle)
```

Required headers for OPFS / WASM to work reliably across browsers:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy:   same-origin
```

These get set differently per host; see below.

### 6.4 Hosting options

| Host                | Free tier good for personal use? | HTTPS auto | Custom headers | One-command deploy |
|---------------------|----------------------------------|------------|----------------|--------------------|
| **Vercel**          | Yes                              | Yes        | `vercel.json`  | `vercel deploy --prod` |
| **Cloudflare Pages**| Yes (very generous)              | Yes        | `_headers` file | `wrangler pages deploy` |
| **Netlify**         | Yes                              | Yes        | `_headers` file | `netlify deploy --prod` |
| **GitHub Pages**    | Yes                              | Yes        | Limited        | git push + Action      |
| **Self-host (Caddy)** | Free if you have a VPS         | Yes (Let's Encrypt) | Yes | scp + reload  |

For a local-first app, **Cloudflare Pages is hard to beat** — generous free
limits, fast global CDN, easy custom-header configuration, and your data never
leaves the user's device anyway, so the host's policies barely matter.

### 6.5 Deploying to Cloudflare Pages

1. Push the repo to GitHub.
2. In the Cloudflare dashboard: Pages → Create a project → Connect to Git.
3. Pick the repo. Build settings:
   - Build command: `npm install && npm --workspace=apps/web run build`
   - Build output directory: `apps/web/out`
   - Node version: `22`
4. Add a `_headers` file in `apps/web/public/`:

   ```
   /*
     Cross-Origin-Embedder-Policy: require-corp
     Cross-Origin-Opener-Policy: same-origin
     X-Frame-Options: DENY
     X-Content-Type-Options: nosniff
     Referrer-Policy: strict-origin-when-cross-origin
   ```

5. First deploy runs automatically. Subsequent pushes to `main` redeploy.

### 6.6 Deploying to Vercel

```bash
cd apps/web
npm install -g vercel
vercel deploy --prod
```

Add a `vercel.json` next to `apps/web/package.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

### 6.7 Custom domain

Whichever host you pick, point your domain at it via DNS (usually a CNAME).
Cloudflare and Vercel both provision the TLS cert automatically. Propagation
takes a few minutes.

### 6.8 Making it installable (PWA)

The web app is also a perfect PWA candidate. Add `apps/web/public/manifest.json`:

```json
{
  "name": "CountRoster",
  "short_name": "CountRoster",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#888888",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

And a minimal service worker (mainly so the browser exposes the "Install"
affordance). Once installed via the browser's "Install app" prompt, the web app
runs in its own window with no browser chrome — close enough to a native
desktop app for most uses.

## 7. CI/CD

A reasonable GitHub Actions setup:

- **On every PR:** `npm test`, `npm run typecheck`, `npm run build` across the
  monorepo.
- **On push to `main`:** auto-deploy `apps/web` (Cloudflare Pages and Vercel do
  this themselves through their Git integration — no Action needed).
- **On a git tag matching `v*`:** trigger EAS Build for both platforms.

Sketch of the tag workflow (`.github/workflows/release.yml`):

```yaml
name: release
on:
  push:
    tags: ['v*']
jobs:
  mobile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}
      - run: cd apps/mobile && eas build --non-interactive --platform all --profile production --auto-submit
```

`EXPO_TOKEN` is a personal access token from your Expo account, stored as a
GitHub repo secret.

## 8. Updates strategy

You have three update paths, in increasing order of friction:

1. **EAS Update (JS-only patches).** Ship a fix in minutes. No store review.
   Cannot change native code, native dependencies, or app permissions. Use for
   typo fixes, UI tweaks, bug fixes in pure TS.

2. **App Store / Play Store release** for anything touching native code or
   dependencies, new permissions, or schema migrations that change the SQLite
   file format. Build → upload → review → release. iOS: 24-48h review; Android:
   hours.

3. **Web deploy.** Push to `main`, host redeploys in a few minutes, users get
   the update on their next page load.

When a release crosses all three, ship the web app first (lowest risk, easiest
rollback), then push the mobile build to TestFlight / Internal Testing, then
promote once you've lived with it for a day or two.

### Schema migrations across versions

Because every platform runs the same `@countroster/core` migration runner against its
local SQLite, the rules are:

- A user who skips one or more versions still ends up on the right schema —
  migrations are applied in order on first run of the new build.
- A backup taken on an older app version restores fine onto a newer app —
  migrations run on the imported DB before it's adopted (see DESIGN §8.3).
- A backup taken on a newer app version onto an older app is **refused** with a
  clear error. This is by design — the older app doesn't know how to read the
  newer schema.

Keep migrations strictly additive (`CREATE TABLE`, `ADD COLUMN`) until you've
shipped enough versions to be confident. Destructive migrations (`DROP COLUMN`,
type changes) are fine eventually but the floor for safe reasoning is "older
apps can still read newer data, possibly losing the new columns" — which only
holds if you don't reuse column names.

## 9. Open decisions before first ship

Things to settle before you spend money on developer accounts and produce art:

| Decision               | Why it matters                                       |
|------------------------|------------------------------------------------------|
| Bundle ID / App ID     | Cannot change after first store submission. Current placeholder: `com.countroster.app`. |
| Icon + splash assets   | Required for both stores; sized variants needed.     |
| Privacy policy URL     | Mandatory for both stores even if you collect nothing. |
| Support URL            | Mandatory for both stores. A GitHub Issues link works. |
| Apple Developer entity | Individual vs Organization affects branding and the App Store seller name. |
| Google Play entity     | Personal account triggers the 12-tester gate; Organization does not. |
| Pricing / free / IAP   | Drives store metadata and entitlements.              |

Privacy policy and support URL can be lightweight: a simple page on the same
domain as the web app. The privacy policy can honestly say "this app stores no
data on our servers; all data is stored on your device. Backup files are
written only to locations you choose."

## 10. Things I'm explicitly not covering here

- **In-app purchases / subscriptions.** Not in scope per DESIGN §2 (non-goals).
- **Crash reporting** beyond Expo's built-in. Adding Sentry is easy when needed.
- **Analytics.** None — also a DESIGN non-goal.
- **Watch app, widgets.** Not in scope (your call).
- **Enterprise / MDM distribution.** Out of scope for a personal app.
- **Alternative app stores** (F-Droid, AltStore, EU sideloading). Worth a look
  later if Play / App Store policies become a problem; not needed for v1.
