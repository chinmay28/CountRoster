The Android build copies the web client built with `vite build --mode native`
here before `go build`, so the engine binary carries the whole UI (see
scripts/build-android.sh). In a bare checkout only this file exists and the
engine serves the API alone (or --web-dist from disk).
