#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
IOS_DIR="$MOBILE_DIR/ios"
DERIVED_DATA="${E2E_IOS_DERIVED_DATA:-/private/tmp/taskhandoff-ios-sim-build}"
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphonesimulator/TaskHandoffStaging.app"
BUNDLE_ID="com.taskhandoff.mobile.staging"
DEVICE_NAME="${E2E_IOS_DEVICE:-TaskHandoff E2E}"
DEVICE_ID="${E2E_IOS_DEVICE_ID:-}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
ARTIFACT_DIR="$SCRIPT_DIR/artifacts/$RUN_ID"

if command -v maestro >/dev/null 2>&1; then
  MAESTRO="$(command -v maestro)"
elif [[ -x "$HOME/.maestro/bin/maestro" ]]; then
  MAESTRO="$HOME/.maestro/bin/maestro"
else
  echo "Maestro is required: curl -Ls https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi

for command in jq xcodebuild xcrun pod; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done

mkdir -p "$ARTIFACT_DIR"

if [[ "${E2E_IOS_SKIP_BUILD:-0}" != "1" ]]; then
  echo "Generating staging iOS project..."
  TASK_HANDOFF_MOBILE_VARIANT=staging \
  TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED=1 \
    pnpm --dir "$REPO_ROOT" --filter @task-handoff/mobile exec expo prebuild --platform ios --clean --no-install \
    >"$ARTIFACT_DIR/prebuild.log" 2>&1

  echo "Installing Pods..."
  (cd "$IOS_DIR" && pod install) >"$ARTIFACT_DIR/pod-install.log" 2>&1

  echo "Building TaskHandoffStaging for the iOS Simulator..."
  if ! TASK_HANDOFF_MOBILE_VARIANT=staging \
    TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED=1 \
    xcodebuild \
      -workspace "$IOS_DIR/TaskHandoffStaging.xcworkspace" \
      -scheme TaskHandoffStaging \
      -configuration Release \
      -sdk iphonesimulator \
      -destination "generic/platform=iOS Simulator" \
      -derivedDataPath "$DERIVED_DATA" \
      build >"$ARTIFACT_DIR/xcodebuild.log" 2>&1; then
    tail -200 "$ARTIFACT_DIR/xcodebuild.log" >&2
    exit 1
  fi
fi

[[ -d "$APP_PATH" ]] || { echo "Missing simulator build: $APP_PATH" >&2; exit 1; }

if [[ -z "$DEVICE_ID" ]]; then
  DEVICE_ID="$(xcrun simctl list devices available --json | jq -r --arg name "$DEVICE_NAME" '.devices | to_entries[] | .value[] | select(.isAvailable == true and .name == $name) | .udid' | head -n 1)"
  if [[ -z "$DEVICE_ID" ]]; then
    DEVICE_TYPE="$(xcrun simctl list devicetypes --json | jq -r '.devicetypes[] | select(.name == "iPhone 16 Pro") | .identifier' | head -n 1)"
    DEVICE_RUNTIME="$(xcrun simctl list runtimes --json | jq -r '[.runtimes[] | select(.isAvailable == true and (.identifier | contains("iOS")))] | sort_by(.version) | reverse | .[0].identifier')"
    echo "Creating simulator $DEVICE_NAME..."
    DEVICE_ID="$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE" "$DEVICE_RUNTIME")"
  fi
fi
[[ -n "$DEVICE_ID" ]] || { echo "No available iOS Simulator named '$DEVICE_NAME'. Set E2E_IOS_DEVICE_ID." >&2; exit 1; }

echo "Using simulator $DEVICE_NAME ($DEVICE_ID)"

if [[ "$(xcrun simctl list devices --json | jq -r --arg id "$DEVICE_ID" '.devices | to_entries[] | .value[] | select(.udid == $id) | .state')" != "Booted" ]]; then
  xcrun simctl boot "$DEVICE_ID"
fi
xcrun simctl bootstatus "$DEVICE_ID" -b

# UI assertions are intentionally readable. Pin the disposable test simulator to
# English so a developer's system language cannot silently change the flow.
if [[ "${E2E_IOS_FORCE_ENGLISH:-1}" == "1" ]]; then
  CURRENT_LANGUAGES="$(xcrun simctl spawn "$DEVICE_ID" defaults read NSGlobalDomain AppleLanguages 2>/dev/null || true)"
  if [[ "$CURRENT_LANGUAGES" != *"en-US"* ]]; then
    xcrun simctl spawn "$DEVICE_ID" defaults write NSGlobalDomain AppleLanguages -array en-US
    xcrun simctl spawn "$DEVICE_ID" defaults write NSGlobalDomain AppleLocale en_US
    xcrun simctl shutdown "$DEVICE_ID"
    xcrun simctl boot "$DEVICE_ID"
    xcrun simctl bootstatus "$DEVICE_ID" -b
  fi
fi

if [[ "${E2E_IOS_RESET_KEYCHAIN:-0}" == "1" ]]; then
  xcrun simctl keychain "$DEVICE_ID" reset
fi

xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl uninstall "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$DEVICE_ID" "$APP_PATH"

maestro_test() {
  local name="$1"
  local flow="$2"
  shift 2
  echo "Running $name..."
  MAESTRO_CLI_NO_ANALYTICS=1 \
  MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    "$MAESTRO" test \
      --udid "$DEVICE_ID" \
      --test-output-dir "$ARTIFACT_DIR/$name" \
      --format JUNIT \
      --output "$ARTIFACT_DIR/$name/junit.xml" \
      "$@" \
      "$flow"
}

maestro_test onboarding "$SCRIPT_DIR/flows/01-onboarding.yaml"

if [[ -n "${E2E_EMAIL:-}" && -n "${E2E_PASSWORD:-}" ]]; then
  maestro_test cloud-relay "$SCRIPT_DIR/flows/02-cloud-relay.yaml" \
    -e "E2E_EMAIL=$E2E_EMAIL" \
    -e "E2E_PASSWORD=$E2E_PASSWORD"

  if [[ -n "${E2E_EXPECTED_TEXT:-}" ]]; then
    maestro_test relay-data "$SCRIPT_DIR/flows/03-relay-data.yaml" \
      -e "E2E_EXPECTED_TEXT=$E2E_EXPECTED_TEXT"
  fi
elif [[ "${E2E_IOS_REQUIRE_RELAY:-0}" == "1" ]]; then
  echo "E2E_EMAIL and E2E_PASSWORD are required when E2E_IOS_REQUIRE_RELAY=1." >&2
  exit 1
else
  echo "Skipping cloud Relay login: set E2E_EMAIL and E2E_PASSWORD."
fi

echo "E2E artifacts: $ARTIFACT_DIR"
