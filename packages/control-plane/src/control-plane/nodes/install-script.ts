function shellScript(strings: TemplateStringsArray) {
  return strings.raw[0].replace(/\\\$\{/g, "${");
}

export function nodeAgentInstallScript() {
  return shellScript`#!/bin/sh
set -eu

MIN_NODE_VERSION="24.15.0"
CONTROL_PLANE_URL=""
JOIN_TOKEN=""
SERVICE_USER="root"
DATA_DIR="/var/lib/task-handoff/node-agent"
ENV_DIR="/etc/task-handoff"
HOST="127.0.0.1"
PORT="8091"
IPC_PATH="/run/task-handoff/node-agent.sock"
TASK_HANDOFF_BIN="\${TASK_HANDOFF_BIN:-}"
PACKAGE_URL="\${TASK_HANDOFF_PACKAGE_URL:-}"
NPM_PACKAGE="\${TASK_HANDOFF_NPM_PACKAGE:-}"
CONTROLLED_INSTANCE_PACKAGE="\${TASK_HANDOFF_CONTROLLED_INSTANCE_PACKAGE:-}"
CONTROLLED_INSTANCE_PACKAGE_URL="\${TASK_HANDOFF_CONTROLLED_INSTANCE_PACKAGE_URL:-}"
VERSION="\${TASK_HANDOFF_VERSION:-}"

usage() {
  cat <<'USAGE'
Usage: install-node-agent.sh --control-plane <url> --join-token <token> [options]

Options:
  --control-plane <url>       Control-plane base URL, for example https://cp.example.com
  --join-token <token>        One-time node join token from the control plane
  --task-handoff-bin <path>   Existing node-agent or legacy task-handoff binary
  --package-url <url>         npm tarball containing task-handoff-node-agent
  --npm-package <name>        node-agent npm package to install globally
  --controlled-instance-package <name>      controlled-instance npm package for local runtimes
  --controlled-instance-package-url <url>   controlled-instance npm tarball for local runtimes
  --version <version>         Version suffix for --npm-package or release directory name
  --data-dir <path>           Node-agent data directory
  --service-user <user>       systemd service user
  --host <host>               Node-agent HTTP bind host, default 127.0.0.1
  --port <port>               Node-agent HTTP port, default 8091

On Debian and Ubuntu, the installer also installs a compatible Node.js 24,
npm, and the native build tools required by the runtime packages.
USAGE
}

die() {
  echo "Error: $*" >&2
  exit 1
}

need_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "This installer must run as root. Re-run with sudo." >&2
    exit 1
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  current_node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  case "$current_node_version" in
    24.*) dpkg --compare-versions "$current_node_version" ge "$MIN_NODE_VERSION" ;;
    *) return 1 ;;
  esac
}

ensure_node_environment() {
  command -v apt-get >/dev/null 2>&1 || die "automatic Node.js installation currently supports Debian and Ubuntu hosts with apt-get"
  command -v dpkg >/dev/null 2>&1 || die "dpkg is required for automatic Node.js installation"

  export DEBIAN_FRONTEND=noninteractive
  echo "Refreshing apt package metadata"
  apt-get update

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

  node_is_compatible || die "Node.js $MIN_NODE_VERSION or newer within the Node.js 24 release line is required; found $(node --version 2>/dev/null || echo none)"
  command -v npm >/dev/null 2>&1 || die "npm was not installed with Node.js"

  # The controlled-instance package contains native addons such as node-pty.
  # Keep node-gyp's fallback toolchain available for installation and updates.
  echo "Ensuring native Node.js build tools are available"
  apt-get install -y --no-install-recommends g++ make python3
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-plane) CONTROL_PLANE_URL="\${2:-}"; shift 2 ;;
    --join-token) JOIN_TOKEN="\${2:-}"; shift 2 ;;
    --task-handoff-bin) TASK_HANDOFF_BIN="\${2:-}"; shift 2 ;;
    --package-url) PACKAGE_URL="\${2:-}"; shift 2 ;;
    --npm-package) NPM_PACKAGE="\${2:-}"; shift 2 ;;
    --controlled-instance-package) CONTROLLED_INSTANCE_PACKAGE="\${2:-}"; shift 2 ;;
    --controlled-instance-package-url) CONTROLLED_INSTANCE_PACKAGE_URL="\${2:-}"; shift 2 ;;
    --version) VERSION="\${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="\${2:-}"; shift 2 ;;
    --service-user) SERVICE_USER="\${2:-}"; shift 2 ;;
    --host) HOST="\${2:-}"; shift 2 ;;
    --port) PORT="\${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

need_root
require_command curl

if [ -z "$CONTROL_PLANE_URL" ]; then
  echo "--control-plane is required." >&2
  exit 1
fi

CONTROL_PLANE_URL="\${CONTROL_PLANE_URL%/}"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required for this installer." >&2
  exit 1
fi

ensure_node_environment

if [ "$SERVICE_USER" != "root" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/task-handoff --shell /usr/sbin/nologin "$SERVICE_USER"
fi
if [ "$SERVICE_USER" != "root" ] && getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$SERVICE_USER" || true
fi

mkdir -p "$DATA_DIR" "$ENV_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR" 2>/dev/null || true

install_from_package_url() {
  require_command npm
  npm install -g --omit=dev --no-audit --no-fund "$PACKAGE_URL"
  TASK_HANDOFF_BIN="$(command -v task-handoff-node-agent)"
}

install_from_npm() {
  require_command npm
  package_spec="$NPM_PACKAGE"
  if [ -n "$VERSION" ]; then
    package_spec="$package_spec@$VERSION"
  fi
  npm install -g --omit=dev --no-audit --no-fund "$package_spec"
  TASK_HANDOFF_BIN="$(command -v task-handoff-node-agent)"
}

if [ -n "$PACKAGE_URL" ]; then
  install_from_package_url
elif [ -n "$TASK_HANDOFF_BIN" ]; then
  if [ ! -x "$TASK_HANDOFF_BIN" ]; then
    echo "--task-handoff-bin must point to an executable file." >&2
    exit 1
  fi
elif [ -n "$NPM_PACKAGE" ]; then
  install_from_npm
elif command -v task-handoff-node-agent >/dev/null 2>&1; then
  TASK_HANDOFF_BIN="$(command -v task-handoff-node-agent)"
elif command -v task-handoff >/dev/null 2>&1; then
  TASK_HANDOFF_BIN="$(command -v task-handoff)"
else
  echo "No node-agent binary found. Pass --package-url, --npm-package, or --task-handoff-bin." >&2
  exit 1
fi

NODE_AGENT_COMMAND="$TASK_HANDOFF_BIN"
case "$(basename "$TASK_HANDOFF_BIN")" in
  task-handoff|task-handoff.js) NODE_AGENT_COMMAND="$TASK_HANDOFF_BIN node-agent" ;;
esac

if [ -n "$CONTROLLED_INSTANCE_PACKAGE_URL" ]; then
  require_command npm
  npm install -g --omit=dev --no-audit --no-fund "$CONTROLLED_INSTANCE_PACKAGE_URL"
elif [ -n "$CONTROLLED_INSTANCE_PACKAGE" ]; then
  require_command npm
  controlled_spec="$CONTROLLED_INSTANCE_PACKAGE"
  if [ -n "$VERSION" ]; then
    controlled_spec="$controlled_spec@$VERSION"
  fi
  npm install -g --omit=dev --no-audit --no-fund "$controlled_spec"
fi

CONTROLLED_INSTANCE_COMMAND=""
if command -v task-handoff-controlled-instance >/dev/null 2>&1; then
  CONTROLLED_INSTANCE_COMMAND="$(command -v task-handoff-controlled-instance) web"
fi
require_command npm
NPM_COMMAND="$(command -v npm)"

cat > "$ENV_DIR/node-agent.env" <<EOF
TASK_HANDOFF_CONTROL_PLANE_URL=$CONTROL_PLANE_URL
TASK_HANDOFF_NODE_AGENT_HOST=$HOST
TASK_HANDOFF_NODE_AGENT_PORT=$PORT
TASK_HANDOFF_NODE_AGENT_DATA_DIR=$DATA_DIR
TASK_HANDOFF_NODE_AGENT_CONNECTION_MODE=local-ipc
TASK_HANDOFF_NODE_AGENT_IPC_PATH=$IPC_PATH
TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND=$CONTROLLED_INSTANCE_COMMAND
TASK_HANDOFF_NPM_COMMAND=$NPM_COMMAND
EOF
chmod 0640 "$ENV_DIR/node-agent.env"

cat > /etc/systemd/system/task-handoff-node-agent.service <<EOF
[Unit]
Description=TaskHandoff Node Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
RuntimeDirectory=task-handoff
RuntimeDirectoryMode=0750
EnvironmentFile=-$ENV_DIR/node-agent.env
ExecStart=$NODE_AGENT_COMMAND --host $HOST --port $PORT --data-dir $DATA_DIR --connection-mode local-ipc --ipc-path $IPC_PATH
Restart=always
RestartSec=3
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
# Compatibility for v0.0.24: enable --now left an already-running process on
# the old package, environment, and unit after a repeated installation.
systemctl enable task-handoff-node-agent.service
systemctl restart task-handoff-node-agent.service

for i in $(seq 1 30); do
  if [ -S "$IPC_PATH" ] && curl --unix-socket "$IPC_PATH" -fsS "http://localhost/api/node-agent/health" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = "30" ]; then
    systemctl status --no-pager task-handoff-node-agent.service || true
    curl --unix-socket "$IPC_PATH" --fail-with-body --show-error "http://localhost/api/node-agent/health" >&2 || true
    echo "Node agent did not become healthy." >&2
    exit 1
  fi
  sleep 1
done

if [ -n "$JOIN_TOKEN" ]; then
  payload="$(mktemp)"
  status="$(curl -sS -o "$payload" -w '%{http_code}' \
    --unix-socket "$IPC_PATH" \
    -H 'content-type: application/json' \
    -d "{\"controlPlaneUrl\":\"$CONTROL_PLANE_URL\",\"joinToken\":\"$JOIN_TOKEN\",\"controlPlaneName\":\"TaskHandoff Control Plane\",\"activate\":true}" \
    "http://localhost/api/node-agent/control-plane-connections")"
  if [ "$status" != "201" ]; then
    cat "$payload" >&2 || true
    rm -f "$payload"
    echo "Node agent pairing failed with HTTP $status." >&2
    exit 1
  fi
  rm -f "$payload"
else
  echo "No --join-token provided; installed node-agent without remote pairing."
fi

echo "TaskHandoff node-agent is installed and running."
echo "Service: task-handoff-node-agent.service"
echo "Pairing token: sudo task-handoff-node-agent invite --ipc-path $IPC_PATH"
echo "Uninstall: sudo task-handoff-node-agent uninstall"
`;
}
