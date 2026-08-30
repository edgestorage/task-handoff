#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

IMAGE_PROFILE="${TASK_HANDOFF_IMAGE_PROFILE:-browser}"
case "${IMAGE_PROFILE}" in
  codex)
    BUILD_TARGET="profile-codex"
    DEFAULT_IMAGE_REF="task-handoff-controlled-codex:local"
    ;;
  opencode)
    BUILD_TARGET="profile-opencode"
    DEFAULT_IMAGE_REF="task-handoff-controlled-opencode:local"
    ;;
  ai)
    BUILD_TARGET="profile-ai"
    DEFAULT_IMAGE_REF="task-handoff-controlled-ai:local"
    ;;
  webcap)
    BUILD_TARGET="profile-webcap"
    DEFAULT_IMAGE_REF="task-handoff-controlled-webcap:local"
    ;;
  browser)
    BUILD_TARGET="profile-browser"
    DEFAULT_IMAGE_REF="task-handoff-controlled-browser:local"
    ;;
  *)
    echo "Unsupported TASK_HANDOFF_IMAGE_PROFILE: ${IMAGE_PROFILE} (expected codex, opencode, ai, webcap, or browser)" >&2
    exit 1
    ;;
esac
IMAGE_REF="${TASK_HANDOFF_IMAGE_REF:-${DEFAULT_IMAGE_REF}}"
DOCKERFILE="${TASK_HANDOFF_DOCKERFILE:-Dockerfile}"
CONTEXT_DIR="${TASK_HANDOFF_DOCKER_CONTEXT:-.}"
BUILD_ID="${TASK_HANDOFF_BUILD_ID:-$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
BUILT_AT="${TASK_HANDOFF_BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
GIT_COMMIT="${TASK_HANDOFF_GIT_COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}"

set -- \
  --file "${DOCKERFILE}" \
  --target "${BUILD_TARGET}" \
  --tag "${IMAGE_REF}" \
  --build-arg "CODEX_CLI_PACKAGE=${CODEX_CLI_PACKAGE:-@openai/codex@latest}" \
  --build-arg "OPENCODE_CLI_PACKAGE=${OPENCODE_CLI_PACKAGE:-opencode-ai@latest}" \
  --build-arg "CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION:-2.1.183}" \
  --build-arg "TASK_HANDOFF_ENABLE_CC_SWITCH=${TASK_HANDOFF_ENABLE_CC_SWITCH:-0}" \
  --build-arg "CC_SWITCH_VERSION=${CC_SWITCH_VERSION:-3.16.3}" \
  --build-arg "CC_SWITCH_DEB_URL=${CC_SWITCH_DEB_URL:-}" \
  --build-arg "CC_SWITCH_COMMAND=${CC_SWITCH_COMMAND:-cc-switch}" \
  --build-arg "CHROMIUM_EXTENSION_URLS=${CHROMIUM_EXTENSION_URLS:-}" \
  --build-arg "CHROMIUM_EXTENSION_IDS=${CHROMIUM_EXTENSION_IDS:-}" \
  --build-arg "CHROMIUM_EXTENSION_UPDATE_URL=${CHROMIUM_EXTENSION_UPDATE_URL:-https://clients2.google.com/service/update2/crx}" \
  --build-arg "WEB_CAPABILITY_VERSION=${WEB_CAPABILITY_VERSION:-0.0.7}" \
  --build-arg "WEB_CAP_EXTENSION_VERSION=${WEB_CAP_EXTENSION_VERSION:-0.0.7}" \
  --build-arg "WEB_CAP_EXTENSION_URL=${WEB_CAP_EXTENSION_URL:-}" \
  --build-arg "TASK_HANDOFF_BUILD_ID=${BUILD_ID}" \
  --build-arg "TASK_HANDOFF_BUILT_AT=${BUILT_AT}" \
  --build-arg "TASK_HANDOFF_GIT_COMMIT=${GIT_COMMIT}" \
  --build-arg "TASK_HANDOFF_IMAGE_REF=${IMAGE_REF}" \
  --build-arg "TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST:-}"

if [ "${TASK_HANDOFF_DOCKER_NO_CACHE:-0}" = "1" ]; then
  set -- "$@" --no-cache
fi

if [ "${TASK_HANDOFF_DOCKER_PULL:-0}" = "1" ]; then
  set -- "$@" --pull
fi

echo "Building ${IMAGE_PROFILE} profile as ${IMAGE_REF} from ${DOCKERFILE}"
exec docker build "$@" "${CONTEXT_DIR}"
