# Mobile releases

The mobile application is built with Expo Application Services (EAS). GitHub Actions does not store Apple distribution certificates, provisioning profiles, or Android keystores directly. EAS owns the native signing credentials.

## One-time setup

1. Join the Apple Developer Program and create the TaskHandoff app in App Store Connect with bundle id `com.taskhandoff.mobile`.
2. Register the widget extension id `com.taskhandoff.mobile.widgets` and App Group `group.com.taskhandoff.mobile` in the Apple Developer portal.
3. Create or select the Expo project that owns the production application.
4. From `apps/mobile`, run an interactive production build once:

   ```sh
   TASK_HANDOFF_MOBILE_VARIANT=production EXPO_PROJECT_ID=<project-id> eas build --platform ios --profile production
   ```

   Allow EAS to create or select the Apple Distribution certificate, provisioning profiles, and widget capabilities.
5. Configure App Store submission credentials once:

   ```sh
   TASK_HANDOFF_MOBILE_VARIANT=production EXPO_PROJECT_ID=<project-id> eas submit --platform ios --profile production
   ```

   Select an App Store Connect API key so EAS can authenticate later non-interactive submissions. In App Store Connect, open **App Information** and record the numeric Apple ID as the `ASC_APP_ID` used below.
6. Initialize the Android keystore with an interactive EAS build:

   ```sh
   TASK_HANDOFF_MOBILE_VARIANT=production EXPO_PROJECT_ID=<project-id> eas build --platform android --profile android-release
   ```

7. Add these GitHub repository variables:

   | Variable | Value |
   | --- | --- |
   | `EXPO_PROJECT_ID` | EAS project UUID |
   | `ASC_APP_ID` | Numeric Apple ID from the TaskHandoff App Store Connect App Information page |

8. Add this GitHub repository secret:

   | Secret | Value |
   | --- | --- |
   | `EXPO_TOKEN` | Expo access token for the account or robot user that owns the EAS project |

9. Create a protected GitHub environment named `ios-production` and require a reviewer. The environment is the manual gate for App Store submission; Android does not use it.

Use a dedicated Expo robot user where the account plan supports it.

## Release

Create one stable mobile tag. It is the only release-version source; the workflow writes that version into `app.json` only in its temporary CI checkout. Mobile tags must contain exactly three numeric components and cannot use prerelease suffixes because the same value becomes the iOS `CFBundleShortVersionString`:

```sh
git tag mobile-v1.0.0
git push origin mobile-v1.0.0
```

The `Mobile Release` workflow validates the production Expo configuration and runs the complete mobile release check, then starts two independent jobs:

- Android immediately builds an installable production APK and uploads it as `TaskHandoff-<version>-android.apk` to the same tag's GitHub Release.
- iOS waits at the protected `ios-production` environment. Only after approval does it build and submit to App Store Connect.

iOS submission uploads the build to App Store Connect/TestFlight. App metadata, screenshots, privacy answers, age rating, pricing, export compliance, review notes, phased release, and the final `Submit for Review` action remain controlled in App Store Connect. Android is not submitted to Google Play by this workflow.
