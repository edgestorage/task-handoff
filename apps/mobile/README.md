# TaskHandoff Mobile

The mobile client is a React Native application built with Expo SDK 57 and Continuous Native Generation (prebuild). It connects directly to a user-managed Control Plane; it does not connect to node-agent endpoints or include an official account/relay client.

## Engineering decision

Expo prebuild was selected over a manually maintained Community CLI native project because the first release requires secure storage, network/lifecycle handling, system file pickers, safe areas, and reproducible iOS/Android configuration. Native projects are generated from `app.config.js` and config plugins, remain ignored, and must not receive hand-maintained product changes.

Expo SDK 57 targets React Native 0.86, React 19.2.3, Android API 36, iOS 16.4+, Node 22.13+ and Xcode 26.4+. The repository's Node 24 requirement satisfies the Expo minimum. Expo 57 automatically supports pnpm workspaces and isolated dependencies, so no custom monorepo Metro resolution is configured.

## Variants and identity

| Variant | Environment | Display name | iOS bundle / Android package | URL scheme |
| --- | --- | --- | --- | --- |
| Development | `TASK_HANDOFF_MOBILE_VARIANT=development` | TaskHandoff Dev | `com.taskhandoff.mobile.dev` | `taskhandoff-dev` |
| Production | `TASK_HANDOFF_MOBILE_VARIANT=production` | TaskHandoff | `com.taskhandoff.mobile` | `taskhandoff` |

Development builds are test builds and accept both HTTP and HTTPS Control Plane origins so a physical device can connect to a server on the local network. Production builds require HTTPS. HTTP test traffic is unencrypted and should be used only on a trusted local network.

Signing credentials are never committed. Local builds use the developer's platform credentials; remote build profiles contain only non-secret variant selection and obtain credentials from the configured build environment.

## Commands

Run commands from the repository root:

```sh
pnpm --filter @task-handoff/mobile lint
pnpm --filter @task-handoff/mobile typecheck
pnpm --filter @task-handoff/mobile test
pnpm --filter @task-handoff/mobile prebuild:check
pnpm --filter @task-handoff/mobile ios
pnpm --filter @task-handoff/mobile android
pnpm --filter @task-handoff/mobile release:check
```

`prebuild:check` regenerates ignored `ios/` and `android/` directories without installing packages. Use `prebuild --clean` after changing native dependencies or app configuration.

`release:check` is the first-release automated gate. It validates source, types, unit/contract behavior, Direct-only network boundaries, reproducible native generation, both production JS bundles, and forbidden production capabilities. Physical iOS and Android device validation remains a separate signed-build gate.

## Product boundary

The first release opens directly into AI Session Inbox and includes active detail, Markdown/code, complete sub-agent display, create/history/resume, composer, approval, interrupt, queue actions, mobile uploads, server-selected runtime files, realtime Node/Instance directories, server-authorized Instance start/stop/restart/image-retry actions, App Session launch/rename/stop, and terminal access. Instance creation/deletion, full Node lifecycle, full file management, model/environment/application installation management, triggers, full settings, official account, and relay features are intentionally absent.

Operator setup and recovery are documented in [mobile-control-plane-operations.md](../../docs/mobile-control-plane-operations.md). The threat model is [mobile-control-plane-security.md](../../docs/mobile-control-plane-security.md). Deferred work is listed in [mobile-control-plane-future-changes.md](../../docs/mobile-control-plane-future-changes.md).

## References

- [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/)
- [Expo monorepo support](https://docs.expo.dev/guides/monorepos/)
- [Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/)
