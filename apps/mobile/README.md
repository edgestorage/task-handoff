# TaskHandoff Mobile

The mobile client is a React Native application built with Expo SDK 57 and Continuous Native Generation (prebuild). It connects to user-managed Control Planes directly or discovers linked Control Planes through the cloud account relay; it does not connect to node-agent endpoints.

## Engineering decision

Expo prebuild was selected over a manually maintained Community CLI native project because the first release requires secure storage, network/lifecycle handling, system file pickers, safe areas, and reproducible iOS/Android configuration. Native projects are generated from `app.config.js` and config plugins, remain ignored, and must not receive hand-maintained product changes.

Expo SDK 57 targets React Native 0.86, React 19.2.3, Android API 36, iOS 16.4+, Node 22.13+ and Xcode 26.4+. The repository's Node 24 requirement satisfies the Expo minimum. Expo 57 automatically supports pnpm workspaces and isolated dependencies, so no custom monorepo Metro resolution is configured.

## Platform UI adaptation

Menus and single-choice pickers keep the native iOS presentation (SwiftUI `Menu`/`ContextMenu` via `@react-native-menu/menu` and `@expo/ui`) but render an iOS-style floating card on Android through `src/components/menu/` (`FloatingMenu`, `FloatingMenuTrigger`, `menu-actions.ts`). Android screens import the platform-neutral adapters `src/components/MenuView.tsx`, `AnchoredSelectMenu.tsx`, and `OptionMenu.tsx`; the matching `.ios.tsx` files keep the native implementations. Add new menu surfaces through those adapters instead of the Android system dropdown/alert lists.

The appearance preference (`system` / `light` / `dark`) lives in `MobileThemeProvider` (`src/components/theme.ts`) and is persisted with SecureStore. Android 12+ also stores it as the application night mode through the `modules/task-handoff-appearance` local module, so configuration-derived surfaces such as the cold-start splash window match the in-app choice even when the system uses the other theme. Android 11 and below, and iOS, keep the system appearance for the native launch screen while the React Native UI still follows the preference.

## Variants and identity

| Variant | Environment | Display name | iOS bundle / Android package | URL scheme |
| --- | --- | --- | --- | --- |
| Development | `TASK_HANDOFF_MOBILE_VARIANT=development` | TaskHandoff Dev | `com.taskhandoff.mobile.dev` | `taskhandoff-dev` |
| Production | `TASK_HANDOFF_MOBILE_VARIANT=production` | TaskHandoff | `com.taskhandoff.mobile` | `taskhandoff` |

Development builds are test builds and accept both HTTP and HTTPS Control Plane origins so a physical device can connect to a server on the local network. Production builds require HTTPS. HTTP test traffic is unencrypted and should be used only on a trusted local network.

Signing credentials are never committed. Local builds use the developer's platform credentials; remote build profiles contain only non-secret variant selection and obtain credentials from the configured build environment.

## Cloud endpoint discovery

Production and staging builds resolve their cloud service endpoints from a versioned DNS TXT record at startup. HTTPS is implied, so the record contains up to five bare host names ordered by priority:

```text
_cloud.thandoff.com TXT "v1 cloud.thandoff.com cloud-backup.thandoff.com"
```

The release fallback origin and TXT record name are supplied with the rest of the production cloud environment. Clients query the record through Alibaba and Cloudflare DoH resolvers, validate the `v1` format and Coordinator host suffixes, persist the last valid list, and use the configured fallback when DNS is unavailable. Safe requests fail over to the next endpoint; account-changing requests are not replayed across endpoints because refresh credentials rotate on every use. All listed endpoints must share the same account, device-session, and binding storage.

Production domain declarations and restrictions are build-time environment variables. No production domain is built into the source tree; the mobile release workflow supplies the values explicitly, and local and ad-hoc builds use the same names.

| Variable | Meaning |
| --- | --- |
| `TASK_HANDOFF_CLOUD_ENV` | Selects the environment identity. |
| `TASK_HANDOFF_CLOUD_SERVICE_ORIGIN` | Canonical Coordinator origin. |
| `TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES` | Coordinator and discovery hosts, including every subdomain. |
| `TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES` | Relay hosts, including every subdomain. |
| `TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY` | Allows plain `ws://` Relay URLs when set to `1`. |
| `TASK_HANDOFF_CLOUD_DISCOVERY_RECORD` | Versioned DNS TXT discovery record. |
| `TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN` | Coordinator origin used when discovery is unavailable. |

The Control Plane and Node Agent release bundles inline the same variables at build time and ignore runtime overrides, so their trust roots are fixed by the signed artifact. Packaged desktop builds materialize the values for their child processes. `TASK_HANDOFF_CLOUD_SERVICE_ORIGINS` optionally adds ordered Coordinator fallback origins.

## Commands

Run commands from the repository root:

```sh
pnpm --filter @task-handoff/mobile lint
pnpm --filter @task-handoff/mobile typecheck
pnpm --filter @task-handoff/mobile test
pnpm --filter @task-handoff/mobile e2e:ios
pnpm --filter @task-handoff/mobile prebuild:check
pnpm --filter @task-handoff/mobile ios
pnpm --filter @task-handoff/mobile android
pnpm --filter @task-handoff/mobile release:check
```

`prebuild:check` regenerates ignored `ios/` and `android/` directories without installing packages. Use `prebuild --clean` after changing native dependencies or app configuration.

`release:check` is the first-release automated gate. It validates source, types, unit/contract behavior, Direct-only network boundaries, reproducible native generation, both production JS bundles, and forbidden production capabilities. Physical iOS and Android device validation remains a separate signed-build gate.

## Product boundary

The mobile client opens directly into AI Session Inbox and includes cloud-account sign-in and relay discovery, active detail, Markdown/code, complete sub-agent display, create/history/resume, composer, approval, interrupt, queue actions, mobile uploads, server-selected runtime files, realtime Node/Instance directories, server-authorized Instance start/stop/restart/image-retry actions, App Session launch/rename/stop, terminal access, and trigger template creation, editing, deployment, and recent-run inspection. Instance creation/deletion, full Node lifecycle, full file management, model/environment/application installation management, and full settings are intentionally absent.

Operator setup and recovery are documented in [mobile-control-plane-operations.md](../../docs/mobile-control-plane-operations.md). The threat model is [mobile-control-plane-security.md](../../docs/mobile-control-plane-security.md). Deferred work is listed in [mobile-control-plane-future-changes.md](../../docs/mobile-control-plane-future-changes.md).

## References

- [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/)
- [Expo monorepo support](https://docs.expo.dev/guides/monorepos/)
- [Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/)
