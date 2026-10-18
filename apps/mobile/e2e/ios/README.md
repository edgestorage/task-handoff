# iOS E2E

Black-box UI tests run the staging app on an iOS Simulator through Maestro. The
suite does not add test-only hooks to the app and uses the same cloud Relay path
as a release build.

## Prerequisites

- Xcode with at least one installed iOS Simulator runtime
- CocoaPods, `jq`, and pnpm
- Maestro: `curl -Ls https://get.maestro.mobile.dev | bash`

The runner creates and reuses a dedicated `TaskHandoff E2E` simulator, so it
does not change the language or data of your normal development simulators.
Override the name with `E2E_IOS_DEVICE`, or pin an exact simulator with
`E2E_IOS_DEVICE_ID`.

## Run

From the repository root:

```sh
pnpm --filter @task-handoff/mobile e2e:ios
```

The runner always builds a fresh staging app with:

```sh
TASK_HANDOFF_MOBILE_VARIANT=staging
TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED=1
```

The onboarding flow verifies that a clean install reaches the Thandoff account
entry point with the staging cloud feature enabled.

To run the real Relay login and cold-start recovery flow, provide credentials
through the environment; they are never stored in the repository:

```sh
E2E_EMAIL='…' E2E_PASSWORD='…' \
  pnpm --filter @task-handoff/mobile e2e:ios
```

Set `E2E_IOS_REQUIRE_RELAY=1` in CI to fail instead of skipping that flow when
credentials are missing. Set `E2E_EXPECTED_TEXT` to a stable node, instance, or
session label to additionally prove that Relay data arrived.

## Useful switches

- `E2E_IOS_SKIP_BUILD=1` reuses the last simulator build.
- `E2E_IOS_DERIVED_DATA=/path` changes the Xcode DerivedData directory.
- `E2E_IOS_RESET_KEYCHAIN=1` clears the selected test simulator's keychain before
  running. This is useful when testing a fresh account state.

Screenshots, command logs, Maestro logs, and JUnit reports are written to
`e2e/ios/artifacts/<run-id>/` and are gitignored.
