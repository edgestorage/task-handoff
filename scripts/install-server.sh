#!/bin/sh
set -eu

MIN_NODE_VERSION="24.15.0"
VERSION=""
CHANNEL="stable"
ARTIFACTS_DIR=""
NPM_REGISTRY=""
INSTALL_DOCKER="1"
SERVICE_USER="root"
CONTROL_PLANE_HOST="0.0.0.0"
CONTROL_PLANE_PORT="8081"
NODE_AGENT_HOST="127.0.0.1"
NODE_AGENT_PORT="8091"
NODE_AGENT_IPC_PATH="/run/task-handoff/node-agent.sock"
AUTH_MODE="password"

usage() {
  cat <<'USAGE'
Usage: install-server.sh [options]

Installs everything needed by a local TaskHandoff server on Debian or Ubuntu:
  - Node.js 24.15.0 or newer within the Node.js 24 release line
  - Docker (unless --skip-docker is used)
  - control-plane, node-agent, and controlled-instance runtime packages
  - task-handoff-control-plane.service and task-handoff-node-agent.service

Package options:
  --channel <channel>               npm channel: stable, beta, or alpha; default stable
  --version <version>               Install an exact runtime package version
  --artifacts-dir <path>            Install the four release tarballs from this directory
  --npm-registry <url>              npm registry used for published runtime packages
  --skip-docker                     Do not install or start Docker

Service options:
  --service-user <user>             systemd service user, default root
  --control-plane-host <host>       Control-plane bind host, default 0.0.0.0
  --control-plane-port <port>       Control-plane port, default 8081
  --node-agent-host <host>          Node-agent bind host, default 127.0.0.1
  --node-agent-port <port>          Node-agent port, default 8091
  --node-agent-ipc-path <path>      Local control socket
  --auth-mode <mode>                Control-plane auth mode: password or disabled
USAGE
}

die() {
  echo "Error: $*" >&2
  exit 1
}

need_root() {
  [ "$(id -u)" = "0" ] || die "run this installer as root (for example: sudo sh install-server.sh)"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --artifacts-dir) ARTIFACTS_DIR="${2:-}"; shift 2 ;;
    --npm-registry) NPM_REGISTRY="${2:-}"; shift 2 ;;
    --skip-docker) INSTALL_DOCKER="0"; shift ;;
    --service-user) SERVICE_USER="${2:-}"; shift 2 ;;
    --control-plane-host) CONTROL_PLANE_HOST="${2:-}"; shift 2 ;;
    --control-plane-port) CONTROL_PLANE_PORT="${2:-}"; shift 2 ;;
    --node-agent-host) NODE_AGENT_HOST="${2:-}"; shift 2 ;;
    --node-agent-port) NODE_AGENT_PORT="${2:-}"; shift 2 ;;
    --node-agent-ipc-path) NODE_AGENT_IPC_PATH="${2:-}"; shift 2 ;;
    --auth-mode) AUTH_MODE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$CHANNEL" = "stable" ] || [ "$CHANNEL" = "beta" ] || [ "$CHANNEL" = "alpha" ] || die "--channel must be stable, beta, or alpha"
[ "$AUTH_MODE" = "password" ] || [ "$AUTH_MODE" = "disabled" ] || die "--auth-mode must be password or disabled"

need_root
command -v apt-get >/dev/null 2>&1 || die "this installer currently supports Debian and Ubuntu hosts with apt-get"
command -v systemctl >/dev/null 2>&1 || die "systemd is required"

export DEBIAN_FRONTEND=noninteractive

echo "[1/5] Refreshing apt package metadata"
apt-get update

echo "[2/5] Ensuring Node.js >= $MIN_NODE_VERSION"
node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  current_node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [ -n "$current_node_version" ] && dpkg --compare-versions "$current_node_version" ge "$MIN_NODE_VERSION"
}

if ! node_is_compatible || ! command -v npm >/dev/null 2>&1; then
  echo "Installing the current official Node.js 24 build with its bundled npm."
  apt-get install -y ca-certificates curl xz-utils
  case "$(dpkg --print-architecture)" in
    amd64) node_arch="x64" ;;
    arm64) node_arch="arm64" ;;
    *) die "automatic Node.js installation supports amd64 and arm64; install Node.js $MIN_NODE_VERSION manually on this architecture" ;;
  esac
  node_tmp="$(mktemp -d)"
  trap 'rm -rf "$node_tmp"' EXIT HUP INT TERM
  curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$node_tmp/SHASUMS256.txt"
  node_archive="$(awk -v suffix="linux-$node_arch.tar.xz" '$2 ~ suffix "$" { print $2; exit }' "$node_tmp/SHASUMS256.txt")"
  [ -n "$node_archive" ] || die "could not find the official Node.js 24 archive for $node_arch"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "$node_tmp/$node_archive"
  expected_checksum="$(awk -v archive="$node_archive" '$2 == archive { print $1; exit }' "$node_tmp/SHASUMS256.txt")"
  actual_checksum="$(sha256sum "$node_tmp/$node_archive" | awk '{ print $1 }')"
  [ "$actual_checksum" = "$expected_checksum" ] || die "Node.js archive checksum verification failed"
  tar -xJf "$node_tmp/$node_archive" --strip-components=1 -C /usr/local
  rm -rf "$node_tmp"
  trap - EXIT HUP INT TERM
fi
node_is_compatible || die "Node.js $MIN_NODE_VERSION or newer is required; found $(node --version 2>/dev/null || echo none)"
command -v npm >/dev/null 2>&1 || die "npm was not installed with Node.js"

# Runtime packages include native Node.js addons such as node-pty. Published
# prebuilds are not guaranteed for every supported Node.js/platform pair, so
# npm must be able to fall back to node-gyp during installation.
echo "Ensuring native Node.js build tools are available"
apt-get install -y --no-install-recommends g++ make python3

echo "[3/5] Ensuring Docker is available"
if [ "$INSTALL_DOCKER" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    apt-get install -y docker.io
  fi
  systemctl enable --now docker.service
  docker info >/dev/null
else
  echo "Docker installation skipped by request."
fi

if [ -n "$VERSION" ]; then
  PACKAGE_TARGET="$VERSION"
elif [ "$CHANNEL" = "stable" ]; then
  PACKAGE_TARGET="latest"
else
  PACKAGE_TARGET="$CHANNEL"
fi
echo "[4/5] Installing TaskHandoff runtime packages $PACKAGE_TARGET"
if [ -n "$ARTIFACTS_DIR" ]; then
  [ -n "$VERSION" ] || die "--version is required when --artifacts-dir is used"
  [ -d "$ARTIFACTS_DIR" ] || die "artifacts directory does not exist: $ARTIFACTS_DIR"
  control_plane_artifact="$ARTIFACTS_DIR/task-handoff-control-plane-$VERSION.tgz"
  node_agent_artifact="$ARTIFACTS_DIR/task-handoff-node-agent-$VERSION.tgz"
  controlled_instance_artifact="$ARTIFACTS_DIR/task-handoff-controlled-instance-$VERSION.tgz"
  server_artifact="$ARTIFACTS_DIR/task-handoff-server-$VERSION.tgz"
  [ -f "$control_plane_artifact" ] || die "missing artifact: $control_plane_artifact"
  [ -f "$node_agent_artifact" ] || die "missing artifact: $node_agent_artifact"
  [ -f "$controlled_instance_artifact" ] || die "missing artifact: $controlled_instance_artifact"
  [ -f "$server_artifact" ] || die "missing artifact: $server_artifact"
  npm install -g "$control_plane_artifact" "$node_agent_artifact" "$controlled_instance_artifact" "$server_artifact"
else
  if [ -n "$NPM_REGISTRY" ]; then
    npm install -g --registry "$NPM_REGISTRY" "@task-handoff/server@$PACKAGE_TARGET"
  else
    npm install -g "@task-handoff/server@$PACKAGE_TARGET"
  fi
fi

command -v task-handoff >/dev/null 2>&1 || die "runtime packages did not install task-handoff"

echo "[5/5] Installing and starting TaskHandoff systemd services"
task-handoff install \
  --service-user "$SERVICE_USER" \
  --control-plane-host "$CONTROL_PLANE_HOST" \
  --control-plane-port "$CONTROL_PLANE_PORT" \
  --node-agent-host "$NODE_AGENT_HOST" \
  --node-agent-port "$NODE_AGENT_PORT" \
  --node-agent-ipc-path "$NODE_AGENT_IPC_PATH" \
  --auth-mode "$AUTH_MODE"

echo "TaskHandoff installation completed."
echo "Open: http://$(hostname -I 2>/dev/null | awk '{ print $1 }'):$CONTROL_PLANE_PORT"
