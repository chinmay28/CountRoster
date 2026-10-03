// Package engine is CountRoster's on-device server: the same /api the server
// binary exposes, bound to loopback inside a mobile app, behind which sits
// either the phone's own database (local mode, the default) or a reverse
// proxy to a CountRoster server (sync mode). The web client can't tell the
// two apart — it always talks to one origin.
//
// The pieces are deliberately small and independent:
//
//   - ConfigStore persists the mode (engine.json, never in SQLite).
//   - Gate admits only the app's own WebView / native shell (loopback ports
//     are reachable by every app on the device).
//   - DNS gives a cgo-free Go process a resolver on Android.
//   - NewProxy forwards /api to a server; Probe inspects one.
//   - Remote and SafetyStore carry data across a mode switch.
//   - Engine composes them and serves /_engine/*, the mode-switch API the
//     web client's Sync settings drive.
//
// See MOBILE.md for the design.
package engine
