# Mobile releases

GitHub Actions owns the mobile release workflow. iOS is generated from the Expo configuration, built and signed on a GitHub-hosted macOS runner, and uploaded directly to App Store Connect. Android continues to use Expo Application Services (EAS) for its keystore and APK build.

## One-time Apple setup

1. Join the Apple Developer Program and create the TaskHandoff app in App Store Connect with bundle id `com.taskhandoff.mobile`.
2. Register these identifiers in the Apple Developer portal:
   - App ID `com.taskhandoff.mobile`, with App Groups and Push Notifications enabled.
   - Widget extension ID `com.taskhandoff.mobile.widgets`, with App Groups enabled.
   - App Group `group.com.taskhandoff.mobile`, assigned to both identifiers.
3. Create Apple App Store distribution provisioning profiles for both identifiers. The profiles must contain the App Group entitlement; the main App profile must also contain the production push entitlement generated for task status Live Activities.
4. Export an **Apple Distribution** certificate and its private key as a password-protected `.p12`. The `MAC_CSC_LINK` used by the desktop release normally contains a Developer ID Application certificate and cannot sign an iOS App Store build.
5. Reuse the desktop release App Store Connect API key if its role can upload builds. The workflow uses the existing `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` secrets.

Encode each binary signing asset as one-line Base64 before storing it in GitHub:

```sh
base64 -i TaskHandoff-Apple-Distribution.p12 | pbcopy
base64 -i TaskHandoff-AppStore.mobileprovision | pbcopy
base64 -i TaskHandoff-Widget-AppStore.mobileprovision | pbcopy
```

Add these GitHub repository variables:

| Variable | Value |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer team identifier used by both iOS targets |
| `EXPO_PROJECT_ID` | EAS project UUID used only by the Android release job |

Add these GitHub Actions secrets. The iOS-only values may be scoped to the protected `ios-production` environment:

| Secret | Value |
| --- | --- |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect API private key; shared with desktop release |
| `APPLE_API_KEY_ID` | App Store Connect API key ID; shared with desktop release |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID; shared with desktop release |
| `IOS_DISTRIBUTION_CERTIFICATE_P12` | Base64-encoded Apple Distribution certificate and private key |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `IOS_APP_PROVISIONING_PROFILE` | Base64-encoded App Store profile for `com.taskhandoff.mobile` |
| `IOS_WIDGET_PROVISIONING_PROFILE` | Base64-encoded App Store profile for `com.taskhandoff.mobile.widgets` |
| `EXPO_TOKEN` | Expo access token used only by the Android release job |

Create a protected GitHub environment named `ios-production` and require a reviewer. Protect the `mobile-v*` tag namespace so only release maintainers can create or update release tags. Pull requests and untrusted forks must never receive release secrets.

## One-time Android setup

Create or select the Expo project that owns the Android application, then initialize its keystore with one interactive EAS build from `apps/mobile`:

```sh
TASK_HANDOFF_MOBILE_VARIANT=production EXPO_PROJECT_ID=<project-id> eas build --platform android --profile android-release
```

Use a dedicated Expo robot user where the account plan supports it.

## Release

Create one stable mobile tag from a reviewed release commit. It is the only release-version source; the workflow writes that version into `app.json` only in its temporary CI checkout. Mobile tags must contain exactly three numeric components and cannot use prerelease suffixes because the same value becomes the iOS `CFBundleShortVersionString`:

```sh
git tag mobile-v1.0.0 <release-commit>
git push oss mobile-v1.0.0
```

The `oss` remote is the public GitHub repository in the standard local checkout. If a checkout uses different remote names, push the tag to `edgestorage/task-handoff`, where the public GitHub Actions workflow runs.

The `Mobile Release` workflow validates the production Expo configuration and runs the complete mobile release check, then starts two independent jobs:

- Android uses EAS to build an installable production APK and attaches it as `TaskHandoff-<version>-android.apk` to the tag's GitHub Release.
- iOS waits at the protected `ios-production` environment. After approval, a GitHub-hosted macOS runner generates the native project, imports the Apple Distribution certificate and both provisioning profiles into temporary signing stores, archives and exports the IPA with Xcode, and uploads it to App Store Connect. The build number is the monotonically increasing GitHub Actions run number.

The iOS upload appears in App Store Connect/TestFlight after Apple finishes processing it. App metadata, screenshots, privacy answers, age rating, pricing, export compliance, review notes, phased release, and the final `Submit for Review` action remain controlled in App Store Connect. Android is not submitted to Google Play by this workflow.
