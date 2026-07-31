#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: pnpm desktop:dist:mac:test <version> [arm64|x64]"
  exit 0
fi

VERSION=${1:-}
if [ -z "$VERSION" ]; then
  echo "Usage: pnpm desktop:dist:mac:test <version> [arm64|x64]" >&2
  exit 1
fi

if ! node -e 'if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(process.argv[1])) process.exit(1)' "$VERSION"; then
  echo "Invalid version: $VERSION" >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS test packages must be built on macOS." >&2
  exit 1
fi

ARCH=${2:-$(uname -m)}
case "$ARCH" in
  arm64) BUILDER_ARCH=arm64 ;;
  x64|x86_64) BUILDER_ARCH=x64 ;;
  *)
    echo "Unsupported macOS architecture: $ARCH (expected arm64 or x64)" >&2
    exit 1
    ;;
esac

export TASK_HANDOFF_VERSION="$VERSION"

pnpm run desktop:runtime:prepare
pnpm run desktop:prepare
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder \
  --mac \
  "--$BUILDER_ARCH" \
  --publish never \
  --config.mac.notarize=false \
  "--config.extraMetadata.version=$VERSION"

DMG_PATH="release/TaskHandoff-$VERSION-mac-$BUILDER_ARCH.dmg"
ZIP_PATH="release/TaskHandoff-$VERSION-mac-$BUILDER_ARCH.zip"

if [ ! -f "$DMG_PATH" ] || [ ! -f "$ZIP_PATH" ]; then
  echo "Build finished without the expected DMG and ZIP artifacts." >&2
  exit 1
fi

echo "macOS test package created:"
echo "  $DMG_PATH"
echo "  $ZIP_PATH"
