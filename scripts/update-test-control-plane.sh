#!/usr/bin/env bash

# Keep this automation aligned with knowledge/update-test-control-plane.md. The task
# document owns the deployment and rollback contract; this script removes the
# repetitive operator steps without weakening its checks.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

HOST=${TASK_HANDOFF_TEST_HOST:-huadream@192.168.139.109}
SSH_PORT=${TASK_HANDOFF_TEST_SSH_PORT:-}
REUSE_ARTIFACTS=${TASK_HANDOFF_TEST_REUSE_ARTIFACTS:-0}
BASE_VERSION=${TASK_HANDOFF_TEST_BASE_VERSION:-0.0.25}
# Test/staging deployments may install a locally packed component into the
# selected test host. Runtime packaging no longer embeds component metadata;
# normal App installation discovers the independently released npm package.
# Set either variable to 0 when intentionally testing without it.
INSTALL_REMOTE_DESKTOP=${TASK_HANDOFF_TEST_REMOTE_DESKTOP:-1}
ENABLE_REMOTE_DESKTOP=${TASK_HANDOFF_TEST_REMOTE_DESKTOP_ENABLE:-1}
# 成功部署后保留的 `.server-*-backup-*` 数量；旧备份自动删除，超过 7 天的
# `-failed-` / `-stage` 残留目录一并清理。0 表示不保留备份。
BACKUP_KEEP=${TASK_HANDOFF_TEST_BACKUP_KEEP:-3}
# 测试环境默认打开 Agent 运行能力：feature flag 在构建期烧进 Control Plane UI
# （packages/control-plane-ui/vite.config.ts 读取 TASK_HANDOFF_AGENT_RUNS_ENABLED），
# 未开启时部署出来的界面不会出现 Agent/编排入口。可用同名环境变量显式覆盖。
TASK_HANDOFF_AGENT_RUNS_ENABLED=${TASK_HANDOFF_AGENT_RUNS_ENABLED:-1}
# 云服务（Thandoff 账户绑定）入口同样在构建期烧进 Control Plane UI；测试环境默认开启，
# 否则设置面板里不会出现云连接分区。
TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED=${TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED:-1}
# Use the same build selection as npm and desktop packaging.
CONTROLLED_INSTANCE_IMPLEMENTATION=$(node --input-type=module -e 'import { resolveControlledInstanceImplementation } from "./runtime-packages.config.mjs"; console.log(resolveControlledInstanceImplementation())')
TASK_HANDOFF_CONTROLLED_INSTANCE_IMPLEMENTATION=$CONTROLLED_INSTANCE_IMPLEMENTATION
export TASK_HANDOFF_CONTROLLED_INSTANCE_IMPLEMENTATION
export TASK_HANDOFF_AGENT_RUNS_ENABLED TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED
# Cloud identity is deployment input, not repository configuration. Require the caller to
# provide one complete mapping so a partial environment cannot silently build with stale
# or missing Relay suffixes.
CLOUD_ENV_VARIABLES=(
  TASK_HANDOFF_CLOUD_ENV
  TASK_HANDOFF_CLOUD_SERVICE_ORIGIN
  TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES
  TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES
  TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY
)
for name in "${CLOUD_ENV_VARIABLES[@]}"; do
  if [ -z "${!name:-}" ]; then
    printf 'Required cloud environment variable is unset: %s\n' "$name" >&2
    exit 1
  fi
done
ARTIFACT_DIR=release/npm/artifacts
REMOTE_DESKTOP_PACKAGE_DIR=release/remote-desktop-packages
BUILD_DATE=$(date +%Y%m%d)
VERSION=${1:-}
AUTO_VERSION=0

log() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$1" >&2
    exit 1
  }
}

build_remote_desktop_package() {
  [ "$INSTALL_REMOTE_DESKTOP" = 1 ] || return 0
  local toolchain docker_arch build_dir package_name tarball metadata
  case "$REMOTE_DESKTOP_ARCH" in
    x64) toolchain=x86_64-unknown-linux-gnu; docker_arch=amd64 ;;
    arm64) toolchain=aarch64-unknown-linux-gnu; docker_arch=arm64 ;;
    *) printf 'Unsupported desktop component architecture: %s\n' "$REMOTE_DESKTOP_ARCH" >&2; exit 1 ;;
  esac
  tarball="$REMOTE_DESKTOP_PACKAGE_DIR/$REMOTE_DESKTOP_PACKAGE_BASENAME"
  metadata="$REMOTE_DESKTOP_PACKAGE_DIR/$REMOTE_DESKTOP_METADATA_BASENAME"
  package_name="@task-handoff/remote-desktop-linux-$REMOTE_DESKTOP_ARCH"
  if [ -f "$tarball" ] && [ -f "$metadata" ] && node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const [metadataFile, packageFile, version, packageName, arch] = process.argv.slice(1);
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    const integrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(packageFile)).digest("base64")}`;
    if (metadata.version !== version || metadata.package !== packageName || metadata.platform !== "linux" || metadata.arch !== arch || metadata.integrity !== integrity) {
      throw new Error(`Stale local desktop package metadata: ${JSON.stringify(metadata)}`);
    }
  ' "$metadata" "$tarball" "$VERSION" "$package_name" "$REMOTE_DESKTOP_ARCH" 2>/dev/null; then
    log "Reuse local remote desktop package $VERSION for linux-$REMOTE_DESKTOP_ARCH"
    return 0
  fi

  build_dir="$REMOTE_DESKTOP_PACKAGE_DIR/.build-linux-$REMOTE_DESKTOP_ARCH"
  require_command docker
  rm -rf "$build_dir"
  docker run --rm \
    --platform "linux/$docker_arch" \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT:/workspace" \
    -w /workspace/remote-desktop-rs \
    -e HOME=/tmp/task-handoff-rust-home \
    -e CARGO_HOME=/tmp/task-handoff-rust-home/cargo \
    -e CARGO_TARGET_DIR="target/local-package-$REMOTE_DESKTOP_ARCH" \
    -e REMOTE_DESKTOP_ARCH="$REMOTE_DESKTOP_ARCH" \
    -e RUST_TOOLCHAIN="$toolchain" \
    rust:1.95-bookworm \
    bash -c '
      set -euo pipefail
      mkdir -p "$HOME" "$CARGO_HOME"
      export PATH="/usr/local/rustup/toolchains/1.95.0-${RUST_TOOLCHAIN}/bin:${PATH}"
      cargo build --locked --release -p desktop-streaming --bin task-handoff-desktop-streaming
      build_bin="/workspace/release/remote-desktop-packages/.build-linux-${REMOTE_DESKTOP_ARCH}/bin"
      mkdir -p "$build_bin"
      # Docker Desktop shared-volume filesystems can reject install command
      # ownership and deallocation handling even for writable destinations.
      cat "$CARGO_TARGET_DIR/release/task-handoff-desktop-streaming" \
        > "$build_bin/task-handoff-desktop-streaming"
      chmod 0755 "$build_bin/task-handoff-desktop-streaming"
    '
  node scripts/remote-desktop-packages.mjs pack \
    --version "$VERSION" \
    --platform linux \
    --arch "$REMOTE_DESKTOP_ARCH" \
    --binary "$build_dir/bin/task-handoff-desktop-streaming" \
    --output "$REMOTE_DESKTOP_PACKAGE_DIR"
  node -e '
    const fs = require("node:fs");
    const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const [version, packageName, arch] = process.argv.slice(2);
    if (metadata.version !== version || metadata.package !== packageName || metadata.platform !== "linux" || metadata.arch !== arch) {
      throw new Error(`Local desktop package metadata mismatch: ${JSON.stringify(metadata)}`);
    }
  ' "$metadata" "$VERSION" "$package_name" "$REMOTE_DESKTOP_ARCH"
  rm -rf "$build_dir"
}

for command in node pnpm git ssh scp shasum; do
  require_command "$command"
done
if [ "$REUSE_ARTIFACTS" != 1 ]; then
  require_command docker
fi

SSH_ARGS=(-o BatchMode=yes)
SCP_ARGS=(-o BatchMode=yes)
if [ -n "$SSH_PORT" ]; then
  case "$SSH_PORT" in
    *[!0-9]*|'') printf 'Unsafe SSH port: %s\n' "$SSH_PORT" >&2; exit 1 ;;
  esac
  SSH_ARGS+=(-p "$SSH_PORT")
  SCP_ARGS+=(-P "$SSH_PORT")
fi

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw new Error(`Node.js 24.15.0 or newer is required; received ${process.version}.`);
'

log "Preflight $HOST"
git status --short
REMOTE_PREFLIGHT=$(ssh "${SSH_ARGS[@]}" "$HOST" 'set -eu
  node --version
  sudo -n true
  systemctl is-active task-handoff-node-agent.service
  systemctl is-active task-handoff-control-plane.service
  systemctl show task-handoff-node-agent.service task-handoff-control-plane.service -p Id -p FragmentPath -p ExecStart -p MainPID --no-pager
  node -p '\''require("/usr/local/lib/node_modules/@task-handoff/server/package.json").version'\''
')
printf '%s\n' "$REMOTE_PREFLIGHT"
printf '%s\n' "$REMOTE_PREFLIGHT" | grep -Fq '/usr/local/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/node-agent/'
printf '%s\n' "$REMOTE_PREFLIGHT" | grep -Fq '/usr/local/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/control-plane/'

case "$INSTALL_REMOTE_DESKTOP:$ENABLE_REMOTE_DESKTOP" in
  [01]:[01]) ;;
  *) printf 'TASK_HANDOFF_TEST_REMOTE_DESKTOP and TASK_HANDOFF_TEST_REMOTE_DESKTOP_ENABLE must be 0 or 1.\n' >&2; exit 1 ;;
esac
REMOTE_DESKTOP_ARCH=
if [ "$INSTALL_REMOTE_DESKTOP" = 1 ]; then
  REMOTE_MACHINE_ARCH=$(ssh "${SSH_ARGS[@]}" "$HOST" 'uname -m')
  case "$REMOTE_MACHINE_ARCH" in
    x86_64|amd64) REMOTE_DESKTOP_ARCH=x64 ;;
    aarch64|arm64) REMOTE_DESKTOP_ARCH=arm64 ;;
    *) printf 'Unsupported test host architecture for the desktop component: %s\n' "$REMOTE_MACHINE_ARCH" >&2; exit 1 ;;
  esac
fi

if [ -z "$VERSION" ]; then
  AUTO_VERSION=1
  VERSION_PREFIX="$BASE_VERSION-local.$BUILD_DATE."
  CANDIDATES=$(
    find "$ARTIFACT_DIR" release/runtime-artifacts -maxdepth 1 -type f -name "*${VERSION_PREFIX}*" -print 2>/dev/null || true
    ssh "${SSH_ARGS[@]}" "$HOST" "find /usr/local/lib/node_modules/@task-handoff /tmp -maxdepth 1 -name '*${VERSION_PREFIX}*' -print 2>/dev/null; node -p 'require(\"/usr/local/lib/node_modules/@task-handoff/server/package.json\").version'"
  )
  NEXT=$(printf '%s\n' "$CANDIDATES" | awk -v prefix="$VERSION_PREFIX" '
    { position = index($0, prefix); if (!position) next; suffix = substr($0, position + length(prefix)); sub(/[^0-9].*/, "", suffix); if (suffix ~ /^[0-9]+$/ && suffix > maximum) maximum = suffix }
    END { print maximum + 1 }
  ')
  VERSION="$VERSION_PREFIX$NEXT"
fi

case "$VERSION" in
  *[!0-9A-Za-z.+-]*|'') printf 'Unsafe version: %s\n' "$VERSION" >&2; exit 1 ;;
esac
case "$BACKUP_KEEP" in
  *[!0-9]*|'') printf 'Unsafe backup keep count: %s\n' "$BACKUP_KEEP" >&2; exit 1 ;;
esac
node -e 'if (!require("semver").valid(process.argv[1])) throw new Error(`Invalid semver: ${process.argv[1]}`)' "$VERSION"

REMOTE_STAGE="/tmp/task-handoff-$VERSION"
CHECKSUMS="/private/tmp/task-handoff-$VERSION.sha256"

# Reserving the remote path before building makes an interrupted deployment
# consume its version instead of allowing different code to reuse it later.
log "Reserve version $VERSION"
while ! ssh "${SSH_ARGS[@]}" "$HOST" "mkdir '$REMOTE_STAGE'" 2>/dev/null; do
  if [ "$AUTO_VERSION" -ne 1 ]; then
    printf 'Version already has a remote deployment path and cannot be reused: %s\n' "$VERSION" >&2
    exit 1
  fi
  NEXT=$((NEXT + 1))
  VERSION="$VERSION_PREFIX$NEXT"
  REMOTE_STAGE="/tmp/task-handoff-$VERSION"
  CHECKSUMS="/private/tmp/task-handoff-$VERSION.sha256"
  printf 'Version is already reserved; trying %s\n' "$VERSION"
done
REMOTE_DESKTOP_PACKAGE_BASENAME=
REMOTE_DESKTOP_METADATA_BASENAME=
if [ "$INSTALL_REMOTE_DESKTOP" = 1 ]; then
  REMOTE_DESKTOP_PACKAGE_BASENAME="task-handoff-remote-desktop-linux-$REMOTE_DESKTOP_ARCH-$VERSION.tgz"
  REMOTE_DESKTOP_METADATA_BASENAME="task-handoff-remote-desktop-linux-$REMOTE_DESKTOP_ARCH-$VERSION.metadata.json"
fi
if [ "$REUSE_ARTIFACTS" != 1 ]; then
  for name in server control-plane node-agent controlled-instance; do
    test ! -e "$ARTIFACT_DIR/task-handoff-$name-$VERSION.tgz" || {
      printf 'Version already has a local artifact and cannot be reused: %s\n' "$VERSION" >&2
      exit 1
    }
  done
  if [ "$INSTALL_REMOTE_DESKTOP" = 1 ]; then
    for name in "$REMOTE_DESKTOP_PACKAGE_BASENAME" "$REMOTE_DESKTOP_METADATA_BASENAME"; do
      test ! -e "$REMOTE_DESKTOP_PACKAGE_DIR/$name" || {
        printf 'Version already has a local desktop package artifact and cannot be reused: %s\n' "$REMOTE_DESKTOP_PACKAGE_DIR/$name" >&2
        exit 1
      }
    done
  fi
fi

log "Build and verify $VERSION (agentRuns=$TASK_HANDOFF_AGENT_RUNS_ENABLED, cloud=$TASK_HANDOFF_CLOUD_ENV, relaySuffixes=$TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES)"
if [ "$INSTALL_REMOTE_DESKTOP" = 1 ]; then
  log "Prepare local remote desktop package for linux-$REMOTE_DESKTOP_ARCH"
  build_remote_desktop_package
fi

if [ "$REUSE_ARTIFACTS" = 1 ]; then
  log "Reuse existing verified artifacts for $VERSION"
else
  pnpm run typecheck:legacy
  pnpm run typecheck:controlled-instance
  pnpm run control-plane-ui:typecheck
  if [ "$CONTROLLED_INSTANCE_IMPLEMENTATION" = "rust" ]; then
    "$ROOT/scripts/build-rust-controlled-instance-linux.sh"
  fi
  TASK_HANDOFF_VERSION="$VERSION" pnpm run runtime:pack --target controlled-instance
  if [ "$CONTROLLED_INSTANCE_IMPLEMENTATION" = "node" ]; then
    TASK_HANDOFF_VERSION="$VERSION" pnpm run runtime:artifact -- --version "$VERSION" --prebuilds-dir release/node-pty-prebuilds
  fi
  TASK_HANDOFF_VERSION="$VERSION" pnpm run runtime:pack
fi

for name in server control-plane node-agent controlled-instance; do
  test -f "$ARTIFACT_DIR/task-handoff-$name-$VERSION.tgz"
done
REMOTE_DESKTOP_TARBALL=
REMOTE_DESKTOP_METADATA=
if [ "$INSTALL_REMOTE_DESKTOP" = 1 ]; then
  REMOTE_DESKTOP_TARBALL="$REMOTE_DESKTOP_PACKAGE_DIR/$REMOTE_DESKTOP_PACKAGE_BASENAME"
  REMOTE_DESKTOP_METADATA="$REMOTE_DESKTOP_PACKAGE_DIR/$REMOTE_DESKTOP_METADATA_BASENAME"
  test -f "$REMOTE_DESKTOP_TARBALL"
  test -f "$REMOTE_DESKTOP_METADATA"
  node -e '
    const fs = require("node:fs");
    const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (metadata.version !== process.argv[2]) throw new Error(`Desktop package version ${metadata.version} does not match ${process.argv[2]}`);
  ' "$REMOTE_DESKTOP_METADATA" "$VERSION"
fi
test -f "release/runtime-artifacts/controlled-instance-runtime-$VERSION-linux-universal.tar.gz"
test -f "release/npm/node-agent/runtime-artifacts/controlled-instance-runtime-$VERSION-linux-universal.tar.gz"

# feature flag 是构建期内联的，产物里必须是本轮要求的取值，否则测试环境会缺少 Agent/编排
# 入口或云服务（Thandoff 账户）入口。
# 直接在待发布的 control-plane tarball 上校验，这样复用旧产物（REUSE_ARTIFACTS=1）时同样有效。
# 校验先把 bundle 解到临时文件：tar 与 `grep -q` 直接构成管道时，grep 命中后提前退出会让
# tar 收到 SIGPIPE，在 `set -o pipefail` 下变成误报。
if [ "$TASK_HANDOFF_AGENT_RUNS_ENABLED" = 1 ]; then EXPECTED_AGENT_RUNS_FLAG='!0'; else EXPECTED_AGENT_RUNS_FLAG='!1'; fi
if [ "$TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED" = 1 ]; then EXPECTED_OFFICIAL_ACCOUNT_FLAG='!0'; else EXPECTED_OFFICIAL_ACCOUNT_FLAG='!1'; fi
CONTROL_PLANE_ASSETS=$(tar -tf "$ARTIFACT_DIR/task-handoff-control-plane-$VERSION.tgz" | grep -E '^package/ui/assets/index-[^/]*\.js$' || true)
CONTROL_PLANE_BUNDLE=${CONTROL_PLANE_ASSETS%%$'\n'*}
CONTROL_PLANE_BUNDLE_TMP=$(mktemp -t task-handoff-control-plane-bundle)
MISSING_FLAG=''
if [ -z "$CONTROL_PLANE_BUNDLE" ] \
  || ! tar -xOf "$ARTIFACT_DIR/task-handoff-control-plane-$VERSION.tgz" "$CONTROL_PLANE_BUNDLE" > "$CONTROL_PLANE_BUNDLE_TMP"; then
  MISSING_FLAG='(ui bundle)'
else
  for flag in "agentRuns:$EXPECTED_AGENT_RUNS_FLAG" "officialAccount:$EXPECTED_OFFICIAL_ACCOUNT_FLAG"; do
    if ! grep -Fq "$flag" "$CONTROL_PLANE_BUNDLE_TMP"; then MISSING_FLAG="$flag"; fi
  done
fi
rm -f "$CONTROL_PLANE_BUNDLE_TMP"
if [ -n "$MISSING_FLAG" ]; then
  printf 'Control Plane UI bundle is missing expected feature flag %s; expected agentRuns=%s officialAccount=%s. Rebuild the artifacts instead of reusing them.\n' \
    "$MISSING_FLAG" "$TASK_HANDOFF_AGENT_RUNS_ENABLED" "$TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED" >&2
  exit 1
fi

# The runtime bundle must contain the expected cloud identity as well as the UI
# feature flags. Checking only the UI bundle would not catch an incomplete Relay suffix list.
bundle_has_cloud_setting() {
  local bundle="$1" name="$2" value="$3"
  # Terser prints identifier keys without quotes, while the pre-minified
  # source quotes them. Accept both representations without parsing JavaScript.
  grep -aFq "\"$name\":\"$value\"" "$bundle" || grep -aFq "$name:\"$value\"" "$bundle"
}

for name in control-plane node-agent; do
  CLOUD_BUNDLE=$(mktemp -t task-handoff-cloud-bundle)
  if ! tar -xOf "$ARTIFACT_DIR/task-handoff-$name-$VERSION.tgz" package/dist/cli.js > "$CLOUD_BUNDLE"; then
    rm -f "$CLOUD_BUNDLE"
    printf 'Runtime package %s is missing dist/cli.js; cannot verify its cloud environment.\n' "$name" >&2
    exit 1
  fi
  for setting in \
    "TASK_HANDOFF_CLOUD_ENV:$TASK_HANDOFF_CLOUD_ENV" \
    "TASK_HANDOFF_CLOUD_SERVICE_ORIGIN:$TASK_HANDOFF_CLOUD_SERVICE_ORIGIN" \
    "TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES:$TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES" \
    "TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES:$TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES"; do
    SETTING_NAME=${setting%%:*}
    SETTING_VALUE=${setting#*:}
    if ! bundle_has_cloud_setting "$CLOUD_BUNDLE" "$SETTING_NAME" "$SETTING_VALUE"; then
      rm -f "$CLOUD_BUNDLE"
      printf 'Runtime package %s is missing expected cloud setting %s. Rebuild the artifacts instead of reusing them.\n' "$name" "$SETTING_NAME" >&2
      exit 1
    fi
  done
  rm -f "$CLOUD_BUNDLE"
done
if [ "$REUSE_ARTIFACTS" = 1 ]; then
  for name in server control-plane node-agent controlled-instance; do
    tar -xOf "$ARTIFACT_DIR/task-handoff-$name-$VERSION.tgz" package/package.json | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
        const manifest = JSON.parse(input);
        if (manifest.version !== process.argv[1]) throw new Error(`${manifest.name}: ${manifest.version}`);
      });
    ' "$VERSION"
  done
else
  node -e '
    const fs = require("node:fs");
    for (const name of ["server", "control-plane", "node-agent", "controlled-instance"]) {
      const current = JSON.parse(fs.readFileSync(`release/npm/${name}/package.json`, "utf8"));
      if (current.version !== process.argv[1]) throw new Error(`${name}: ${current.version}`);
    }
  ' "$VERSION"
fi

CHECKSUM_INPUTS=(
  "$ARTIFACT_DIR/task-handoff-server-$VERSION.tgz"
  "$ARTIFACT_DIR/task-handoff-control-plane-$VERSION.tgz"
  "$ARTIFACT_DIR/task-handoff-node-agent-$VERSION.tgz"
  "$ARTIFACT_DIR/task-handoff-controlled-instance-$VERSION.tgz"
)
if [ "$INSTALL_REMOTE_DESKTOP" = 1 ]; then
  CHECKSUM_INPUTS+=("$REMOTE_DESKTOP_TARBALL" "$REMOTE_DESKTOP_METADATA")
fi
shasum -a 256 "${CHECKSUM_INPUTS[@]}" | sed -E 's#  .*/([^/]+)$#  \1#' > "$CHECKSUMS"
cat "$CHECKSUMS"

log "Upload and assemble new runtime"
scp "${SCP_ARGS[@]}" \
  "$ARTIFACT_DIR/task-handoff-server-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-control-plane-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-node-agent-$VERSION.tgz" \
  "$ARTIFACT_DIR/task-handoff-controlled-instance-$VERSION.tgz" \
  ${REMOTE_DESKTOP_TARBALL:+"$REMOTE_DESKTOP_TARBALL"} \
  ${REMOTE_DESKTOP_METADATA:+"$REMOTE_DESKTOP_METADATA"} \
  "$CHECKSUMS" \
  "$HOST:$REMOTE_STAGE/"

ssh "${SSH_ARGS[@]}" "$HOST" \
  "sudo -n env VERSION='$VERSION' REMOTE_STAGE='$REMOTE_STAGE' bash -s" <<'REMOTE'
set -eu
cd "$REMOTE_STAGE"
sha256sum -c "task-handoff-$VERSION.sha256"
NEW="/usr/local/lib/node_modules/@task-handoff/.server-$VERSION-stage"
test ! -e "$NEW"
install -d -m 0755 "$NEW"
tar -xzf "$REMOTE_STAGE/task-handoff-server-$VERSION.tgz" -C "$NEW" --strip-components=1
for name in control-plane node-agent controlled-instance; do
  # npm treats sibling packages under node_modules/@task-handoff as one install
  # tree and prunes the other runtime packages. Install each package in isolation
  # before assembling the self-contained server directory.
  INSTALL_ROOT="$REMOTE_STAGE/.install-$name"
  PACKAGE="$NEW/node_modules/@task-handoff/$name"
  test ! -e "$INSTALL_ROOT"
  test ! -e "$PACKAGE"
  install -d -m 0755 "$INSTALL_ROOT"
  tar -xzf "$REMOTE_STAGE/task-handoff-$name-$VERSION.tgz" -C "$INSTALL_ROOT" --strip-components=1
  npm install --prefix "$INSTALL_ROOT" --omit=dev --legacy-peer-deps --ignore-scripts
  install -d -m 0755 "$(dirname "$PACKAGE")"
  mv "$INSTALL_ROOT" "$PACKAGE"
done
node -e '
  const root = process.argv[1];
  const expected = process.argv[2];
  for (const name of ["server", "control-plane", "node-agent", "controlled-instance"]) {
    const file = name === "server" ? `${root}/package.json` : `${root}/node_modules/@task-handoff/${name}/package.json`;
    const version = require(file).version;
    if (version !== expected) throw new Error(`${name}: ${version}`);
  }
' "$NEW" "$VERSION"
test -x "$NEW/node_modules/@task-handoff/node-agent/bin/task-handoff-node-agent"
test -x "$NEW/node_modules/@task-handoff/control-plane/bin/task-handoff-control-plane"
REMOTE

log "Atomically switch Node Agent and Control Plane"
SWITCH_OUTPUT=$(ssh "${SSH_ARGS[@]}" "$HOST" \
  "sudo -n env VERSION='$VERSION' bash -s" <<'REMOTE'
set -eu
BASE=/usr/local/lib/node_modules/@task-handoff
CURRENT="$BASE/server"
NEW="$BASE/.server-$VERSION-stage"
BIN_DIR=/usr/local/bin
NODE_AGENT_LINK="$BIN_DIR/task-handoff-node-agent"
CONTROL_PLANE_LINK="$BIN_DIR/task-handoff-control-plane"
OLD_VERSION=$(node -p "require('$CURRENT/package.json').version")
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="$BASE/.server-$OLD_VERSION-backup-$STAMP"
FAILED="$BASE/.server-$VERSION-failed-$STAMP"
test -d "$CURRENT"
test -d "$NEW"
NODE_PID_BEFORE=$(systemctl show task-handoff-node-agent.service -p MainPID --value)
CONTROL_PID_BEFORE=$(systemctl show task-handoff-control-plane.service -p MainPID --value)
SWITCHED=0
atomic_command_link() {
  link="$1"
  target="$2"
  temporary="$link.tmp.$$"
  rm -f "$temporary"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}
install_command_links() {
  atomic_command_link "$NODE_AGENT_LINK" "$CURRENT/node_modules/@task-handoff/node-agent/bin/task-handoff-node-agent"
  atomic_command_link "$CONTROL_PLANE_LINK" "$CURRENT/node_modules/@task-handoff/control-plane/bin/task-handoff-control-plane"
}
rollback() {
  systemctl stop task-handoff-control-plane.service || true
  systemctl stop task-handoff-node-agent.service || true
  if [ "$SWITCHED" -eq 1 ]; then
    if [ -d "$CURRENT" ]; then mv "$CURRENT" "$FAILED"; fi
    if [ -d "$BACKUP" ]; then mv "$BACKUP" "$CURRENT"; fi
  fi
  install_command_links || true
  systemctl start task-handoff-node-agent.service
  systemctl start task-handoff-control-plane.service
  echo "Deployment failed; previous server runtime restored." >&2
}
trap 'rollback' ERR
systemctl stop task-handoff-control-plane.service
systemctl stop task-handoff-node-agent.service
mv "$CURRENT" "$BACKUP"
mv "$NEW" "$CURRENT"
SWITCHED=1
install_command_links
systemctl start task-handoff-node-agent.service
for attempt in $(seq 1 30); do
  [ -S /run/task-handoff/node-agent.sock ] && break
  sleep 1
done
test -S /run/task-handoff/node-agent.sock
systemctl is-active --quiet task-handoff-node-agent.service
systemctl start task-handoff-control-plane.service
healthy=0
for attempt in $(seq 1 30); do
  response=$(curl -fsS http://127.0.0.1:8081/api/health 2>/dev/null || true)
  if printf '%s' "$response" | grep -Fq '"ok":true' && printf '%s' "$response" | grep -Fq "\"packageVersion\":\"$VERSION\""; then
    healthy=1
    break
  fi
  sleep 1
done
test "$healthy" -eq 1
NODE_PID_AFTER=$(systemctl show task-handoff-node-agent.service -p MainPID --value)
CONTROL_PID_AFTER=$(systemctl show task-handoff-control-plane.service -p MainPID --value)
test "$NODE_PID_AFTER" -gt 0
test "$CONTROL_PID_AFTER" -gt 0
test "$NODE_PID_AFTER" != "$NODE_PID_BEFORE"
test "$CONTROL_PID_AFTER" != "$CONTROL_PID_BEFORE"
trap - ERR
printf 'backup=%s\n' "$BACKUP"
printf 'node_agent_command=%s\n' "$(readlink "$NODE_AGENT_LINK")"
printf 'control_plane_command=%s\n' "$(readlink "$CONTROL_PLANE_LINK")"
printf 'node_agent_pid=%s -> %s\n' "$NODE_PID_BEFORE" "$NODE_PID_AFTER"
printf 'control_plane_pid=%s -> %s\n' "$CONTROL_PID_BEFORE" "$CONTROL_PID_AFTER"
REMOTE
)
printf '%s\n' "$SWITCH_OUTPUT"

log "Validate runtime and controlled-instance convergence"
ssh "${SSH_ARGS[@]}" "$HOST" "sudo -n env VERSION='$VERSION' bash -s" <<'REMOTE'
set -eu
test "$(node -p 'require("/usr/local/lib/node_modules/@task-handoff/server/package.json").version')" = "$VERSION"
test "$(/usr/local/bin/task-handoff-node-agent --version)" = "$VERSION"
test "$(/usr/local/bin/task-handoff-control-plane --version)" = "$VERSION"
systemctl is-active --quiet task-handoff-node-agent.service
systemctl is-active --quiet task-handoff-control-plane.service
test -S /run/task-handoff/node-agent.sock
health=$(curl -fsS http://127.0.0.1:8081/api/health)
printf '%s' "$health" | grep -Fq '"ok":true'
printf '%s' "$health" | grep -Fq "\"packageVersion\":\"$VERSION\""
curl -fsS http://127.0.0.1:8081/api/control-plane/identity >/dev/null

converged=0
for attempt in $(seq 1 90); do
  instances=$(curl -fsS --unix-socket /run/task-handoff/node-agent.sock http://localhost/api/node-agent/instances)
  if printf '%s' "$instances" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
      const expected = process.argv[1];
      const active = (JSON.parse(input).data || []).filter((item) => item.status !== "stopped");
      process.exit(active.every((item) => item.ready && item.runtimeVersion?.desiredVersion === expected && item.runtimeVersion?.actualVersion === expected && item.runtimeVersion?.phase === "matched") ? 0 : 1);
    });
  ' "$VERSION"; then
    converged=1
    break
  fi
  sleep 1
done
test "$converged" -eq 1

printf 'health=%s\n' "$health"
# Node Agent owns private registration/configuration fields in this response.
# Deployment evidence must project only readiness/version facts, never dump it.
printf '%s' "$instances" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
    const data = (JSON.parse(input).data || []).map(({ id, nodeId, status, ready, runtimeVersion }) => ({ id, nodeId, status, ready, runtimeVersion }));
    console.log(`instances=${JSON.stringify({ data })}`);
  });
'
printf 'ui_assets='
curl -fsS http://127.0.0.1:8081/ | grep -oE 'assets/[^" ]+\.(js|css)' | sort -u | tr '\n' ','
printf '\n'
REMOTE

if [ "$INSTALL_REMOTE_DESKTOP" = 1 ]; then
  log "Install local remote desktop package $VERSION"
  ssh "${SSH_ARGS[@]}" "$HOST" \
    "sudo -n env VERSION='$VERSION' REMOTE_STAGE='$REMOTE_STAGE' REMOTE_DESKTOP_PACKAGE='$REMOTE_DESKTOP_PACKAGE_BASENAME' REMOTE_DESKTOP_METADATA='$REMOTE_DESKTOP_METADATA_BASENAME' ENABLE_REMOTE_DESKTOP='$ENABLE_REMOTE_DESKTOP' bash -s" <<'REMOTE'
set -eu
PACKAGE_FILE="$REMOTE_STAGE/$REMOTE_DESKTOP_PACKAGE"
METADATA_FILE="$REMOTE_STAGE/$REMOTE_DESKTOP_METADATA"
test -f "$PACKAGE_FILE"
test -f "$METADATA_FILE"

PACKAGE_NAME=$(node -e 'process.stdout.write(require(process.argv[1]).package)' "$METADATA_FILE")
PACKAGE_VERSION=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$METADATA_FILE")
PACKAGE_INTEGRITY=$(node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  process.stdout.write(`sha512-${crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64")}`);
' "$PACKAGE_FILE")
test "$PACKAGE_VERSION" = "$VERSION"

NODE_AGENT_PID=$(systemctl show task-handoff-node-agent.service -p MainPID --value)
test "$NODE_AGENT_PID" -gt 0
NODE_AGENT_DATA_DIR=$(tr '\0' '\n' < "/proc/$NODE_AGENT_PID/environ" | sed -n 's/^TASK_HANDOFF_NODE_AGENT_DATA_DIR=//p' | tail -n 1)
NODE_AGENT_DATA_DIR=${NODE_AGENT_DATA_DIR:-/var/lib/task-handoff/node-agent}
test -d "$NODE_AGENT_DATA_DIR"

INSTANCES_FILE=$(mktemp)
RUNTIMES_FILE=$(mktemp)
LOCAL_INSTANCES_FILE=$(mktemp)
trap 'rm -f "$INSTANCES_FILE" "$RUNTIMES_FILE" "$LOCAL_INSTANCES_FILE"' EXIT
curl -fsS --unix-socket /run/task-handoff/node-agent.sock http://localhost/api/node-agent/instances > "$INSTANCES_FILE"
curl -fsS --unix-socket /run/task-handoff/node-agent.sock http://localhost/api/node-agent/runtimes > "$RUNTIMES_FILE"
node -e '
  const fs = require("node:fs");
  const instances = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).data || [];
  const runtimes = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).data || [];
  const localRuntimes = new Set(runtimes.filter((runtime) => runtime.type === "local").map((runtime) => runtime.id));
  for (const instance of instances) {
    if (localRuntimes.has(instance.runtimeId) && instance.status !== "deleted") {
      process.stdout.write(`${instance.id}\t${instance.status}\n`);
    }
  }
' "$INSTANCES_FILE" "$RUNTIMES_FILE" > "$LOCAL_INSTANCES_FILE"

if [ ! -s "$LOCAL_INSTANCES_FILE" ]; then
  printf 'No local controlled instances; desktop package remains staged at %s\n' "$PACKAGE_FILE"
  exit 0
fi

install -d -m 0755 /var/lib/task-handoff/remote-desktop-artifacts
install -m 0644 "$PACKAGE_FILE" "/var/lib/task-handoff/remote-desktop-artifacts/$REMOTE_DESKTOP_PACKAGE"
install -m 0644 "$METADATA_FILE" "/var/lib/task-handoff/remote-desktop-artifacts/$REMOTE_DESKTOP_METADATA"

while IFS=$'\t' read -r INSTANCE_ID INSTANCE_STATUS; do
  [ -n "$INSTANCE_ID" ] || continue
  INSTANCE_DIR="$NODE_AGENT_DATA_DIR/local-instances/$INSTANCE_ID"
  test -d "$INSTANCE_DIR"
  NATIVE_ROOT="$INSTANCE_DIR/managed-apps/native"
  TARGET="$NATIVE_ROOT/remote-desktop"
  STAGE="$NATIVE_ROOT/.remote-desktop-stage-$VERSION-$$"
  BACKUP="$TARGET.installed-before-$VERSION-$(date +%Y%m%d%H%M%S)"
  OWNER=$(stat -c '%u:%g' "$INSTANCE_DIR")
  OWNER_USER=$(stat -c '%U' "$INSTANCE_DIR")

  rm -rf "$STAGE"
  install -d -m 0755 "$STAGE"
  tar -xzf "$PACKAGE_FILE" -C "$STAGE" --strip-components=1
  test -x "$STAGE/bin/task-handoff-desktop-streaming"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [staging, installRoot, version, packageName, integrity] = process.argv.slice(1);
    const files = [];
    const walk = (directory, prefix = "") => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
        else if (entry.isFile()) files.push(relative);
        else throw new Error(`Unsupported desktop package entry: ${relative}`);
      }
    };
    walk(staging);
    files.push("managed-app.json");
    const manifest = {
      schemaVersion: 1,
      appId: "remote-desktop",
      version,
      package: packageName,
      packageVersion: version,
      integrity,
      installRoot,
      launchPath: "bin/task-handoff-desktop-streaming",
      files: files.sort(),
    };
    fs.writeFileSync(path.join(staging, "managed-app.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  ' "$STAGE" "$TARGET" "$VERSION" "$PACKAGE_NAME" "$PACKAGE_INTEGRITY"
  chown -R "$OWNER" "$STAGE"
  runuser -u "$OWNER_USER" -- "$STAGE/bin/task-handoff-desktop-streaming" --version >/dev/null

  if [ -e "$TARGET" ]; then mv "$TARGET" "$BACKUP"; fi
  if ! mv "$STAGE" "$TARGET"; then
    if [ -d "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi
    printf 'Desktop package replacement failed for %s\n' "$INSTANCE_ID" >&2
    exit 1
  fi

  if [ "$ENABLE_REMOTE_DESKTOP" = 1 ]; then
    case "$INSTANCE_STATUS" in
      stopped|created|deleting|deleted)
        printf 'remote_desktop_instance=%s package=%s state=installed-until-start\n' "$INSTANCE_ID" "$VERSION"
        continue
        ;;
    esac
    desktop_control() {
      curl -fsS --unix-socket /run/task-handoff/node-agent.sock \
        -X POST -H 'content-type: application/json' -d "$2" \
        "http://localhost/api/node-agent/instances/$INSTANCE_ID/remote-desktop/$1"
    }
    desktop_control settings-set '{"enabled":false}' >/dev/null
    desktop_control settings-set '{"enabled":true}' >/dev/null
    running_binary_matches() {
      EXPECTED=$(readlink -f "$TARGET/bin/task-handoff-desktop-streaming" 2>/dev/null || true)
      [ -n "$EXPECTED" ] || return 1
      for link in /proc/[0-9]*/exe; do
        [ "$(readlink -f "$link" 2>/dev/null || true)" = "$EXPECTED" ] && return 0
      done
      return 1
    }
    READY=0
    for attempt in $(seq 1 30); do
      CAPABILITY=$(desktop_control preflight '{}' 2>/dev/null || true)
      if printf '%s' "$CAPABILITY" | node -e '
        let input = "";
        process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
          try { process.exit(JSON.parse(input)?.data?.available === true ? 0 : 1); } catch { process.exit(1); }
        });
      ' && running_binary_matches; then
        READY=1
        break
      fi
      sleep 1
    done
    if [ "$READY" -ne 1 ]; then
      desktop_control settings-set '{"enabled":false}' >/dev/null || true
      rm -rf "$TARGET"
      if [ -d "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi
      desktop_control settings-set '{"enabled":true}' >/dev/null || true
      printf 'Desktop component did not become ready from the installed package for %s; previous package restored.\n' "$INSTANCE_ID" >&2
      exit 1
    fi
    printf 'remote_desktop_instance=%s package=%s capability=%s\n' "$INSTANCE_ID" "$VERSION" "$CAPABILITY"
  else
    printf 'remote_desktop_instance=%s package=%s state=installed\n' "$INSTANCE_ID" "$VERSION"
  fi
done < "$LOCAL_INSTANCES_FILE"
REMOTE
fi

log "Prune old deployment backups (keep newest $BACKUP_KEEP)"
ssh "${SSH_ARGS[@]}" "$HOST" "sudo -n env BACKUP_KEEP='$BACKUP_KEEP' bash -s" <<'REMOTE'
set -eu
BASE=/usr/local/lib/node_modules/@task-handoff
ls -dt "$BASE"/.server-*-backup-* 2>/dev/null | {
  index=0
  while IFS= read -r backup; do
    if [ "$index" -lt "$BACKUP_KEEP" ]; then
      printf 'kept_backup=%s\n' "$backup"
    elif [ -d "$backup" ]; then
      rm -rf -- "$backup"
      printf 'pruned_backup=%s\n' "$backup"
    fi
    index=$((index + 1))
  done
}
find "$BASE" -maxdepth 1 -type d \( -name '.server-*-failed-*' -o -name '.server-*-stage' \) -mtime +7 -print -exec rm -rf -- {} +
REMOTE

log "Deployment complete"
printf 'version=%s\n' "$VERSION"
printf '%s\n' "$SWITCH_OUTPUT"
printf 'remote_stage=%s\n' "$REMOTE_STAGE"
printf 'Kept the newest %s server backup(s); older backups and stale failed/stage dirs were pruned.\n' "$BACKUP_KEEP"
