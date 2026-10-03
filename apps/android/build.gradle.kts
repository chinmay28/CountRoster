// The Android shell around CountRoster's on-device engine. See MOBILE.md and
// app/README.md; build it with scripts/build-android.sh, which builds the Go
// engine and the web bundle this project packages.
plugins {
    id("com.android.application") version "8.11.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.0" apply false
}
