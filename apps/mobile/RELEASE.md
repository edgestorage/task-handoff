# Mobile releases

GitHub Actions owns the mobile release workflow. Expo generates both native projects. GitHub-hosted Linux and macOS runners build and sign Android and iOS respectively; iOS is uploaded directly to App Store Connect.

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

Add this GitHub repository variable:

| Variable | Value |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer team identifier used by both iOS targets |

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

Create a protected GitHub environment named `ios-production` and require a reviewer. Protect the `mobile-v*` tag namespace so only release maintainers can create or update release tags. Pull requests and untrusted forks must never receive release secrets.

## One-time Android setup

Create a long-lived Android release keystore before the first published build. This key is the application identity for direct APK upgrades and cannot be replaced without breaking upgrade compatibility. Keep an offline backup of the keystore and its passwords.

```sh
keytool -genkeypair -v \
  -keystore TaskHandoff-Android-Release.jks \
  -storetype JKS \
  -alias taskhandoff \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
base64 -i TaskHandoff-Android-Release.jks | pbcopy
```

Create a protected GitHub environment named `android-production`, require a reviewer, and add these secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | One-line Base64 encoding of the release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Release key alias, such as `taskhandoff` |
| `ANDROID_KEY_PASSWORD` | Private key password |

Restrict both production environments to the `mobile-v*` tag namespace.

## Release

Create one stable mobile tag from a reviewed release commit. It is the only release-version source; the workflow writes that version into `app.json` only in its temporary CI checkout. Mobile tags must contain exactly three numeric components and cannot use prerelease suffixes because the same value becomes the iOS `CFBundleShortVersionString`:

```sh
git tag mobile-v1.0.0 <release-commit>
git push oss mobile-v1.0.0
```

The `oss` remote is the public GitHub repository in the standard local checkout. If a checkout uses different remote names, push the tag to `edgestorage/task-handoff`, where the public GitHub Actions workflow runs.

The `Mobile Release` workflow validates the production Expo configuration and runs the complete mobile release check, then starts two independent jobs:

- Android waits at the protected `android-production` environment, generates the native project, builds a signed release APK with Gradle, verifies its signature, and attaches it as `TaskHandoff-<version>-android.apk` to the tag's GitHub Release. Its integer version code is the monotonically increasing GitHub Actions run number.
- iOS waits at the protected `ios-production` environment. After approval, a GitHub-hosted macOS runner generates the native project, imports the Apple Distribution certificate and both provisioning profiles into temporary signing stores, archives and exports the IPA with Xcode, and uploads it to App Store Connect. The build number is the monotonically increasing GitHub Actions run number.

## App Store review: Sign in with Apple

Sign in with Apple is required by App Store Review Guideline 4.8 because the cloud account screen
offers Google and GitHub sign-in. The login screen therefore only renders third-party providers when
the server's public provider directory lists `apple`; if the directory omits it (feature flag off, or
the lookup failed), Google and GitHub are hidden and only email/password sign-in remains.

Before submitting a build that shows the Apple button, confirm:

1. The cloud platform has `FEATURE_OFFICIAL_APPLE_SIGN_IN=true` and a valid
   `coordinator/providers/apple` credential, so `GET /api/v1/auth/providers` returns `apple`.
2. The Apple Developer portal has a Services ID whose redirect URL is
   `https://cloud.thandoff.com/api/v1/auth/providers/apple/callback`.
3. The App Store privacy answers and review notes mention that Apple sign-in data (stable identifier,
   optional verified or private-relay email, display name) is used to identify the account.

The one-time Apple Developer setup above covers certificates and provisioning only; the Services ID,
key and team identifier are configured in the cloud platform, not in this repository.

The iOS upload appears in App Store Connect/TestFlight after Apple finishes processing it. App metadata, screenshots, privacy answers, age rating, pricing, export compliance, review notes, phased release, and the final `Submit for Review` action remain controlled in App Store Connect. Android is not submitted to Google Play by this workflow.
