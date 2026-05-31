import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the built web app (`webDir`) in a native iOS shell you can
 * open and run from Xcode. See README.md → "Run on an iPhone via Xcode".
 *
 * `appId` must be globally unique for free (personal-team) provisioning to
 * sign cleanly — change it to something with your own reverse-domain prefix
 * before generating the iOS project (`npm run ios:add`).
 */
const config: CapacitorConfig = {
  appId: 'app.countroster.mobile',
  appName: 'CountRoster',
  webDir: 'dist',
  ios: {
    // Let content extend under the status bar / home indicator; the app's own
    // layout handles spacing.
    contentInset: 'always',
  },
};

export default config;
