#!/bin/sh
set -eu

INSTALLER_BIN_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "$INSTALLER_BIN_DIR/.." && pwd)"
TASK_HANDOFF_BIN=""
TASK_HANDOFF_COMMAND=""
CONTROL_PLANE_BIN=""
NODE_AGENT_BIN=""
CONTROLLED_INSTANCE_BIN=""
CONTROL_PLANE_COMMAND=""
NODE_AGENT_COMMAND=""
CONTROLLED_INSTANCE_COMMAND=""
SERVICE_USER="root"
ENV_DIR="/etc/task-handoff"
CONTROL_PLANE_DATA_DIR="/var/lib/task-handoff/control-plane"
NODE_AGENT_DATA_DIR="/var/lib/task-handoff/node-agent"
CONTROL_PLANE_HOST="0.0.0.0"
CONTROL_PLANE_PORT="8081"
NODE_AGENT_HOST="127.0.0.1"
NODE_AGENT_PORT="8091"
NODE_AGENT_IPC_PATH="/run/task-handoff/node-agent.sock"
AUTH_MODE="password"
STATIC_DIR=""

usage() {
  cat <<'USAGE'
Usage: scripts/install-server-services.sh [options]

Installs server-side TaskHandoff services on a systemd host:
  task-handoff-node-agent.service
  task-handoff-control-plane.service

Options:
  --repo-dir <path>                 Repository or unpacked release directory
  --task-handoff-bin <path>         Legacy combined task-handoff executable
  --control-plane-bin <path>        Control-plane executable
  --node-agent-bin <path>           Node-agent executable
  --controlled-instance-bin <path>  Controlled-instance executable for local runtimes
  --service-user <user>             systemd service user, default root
  --control-plane-data-dir <path>   Control-plane data directory
  --node-agent-data-dir <path>      Node-agent data directory
  --control-plane-host <host>       Control-plane bind host, default 0.0.0.0
  --control-plane-port <port>       Control-plane port, default 8081
  --node-agent-host <host>          Local node-agent bind host, default 127.0.0.1
  --node-agent-port <port>          Local node-agent port, default 8091
  --node-agent-ipc-path <path>      Local control socket, default /run/task-handoff/node-agent.sock
  --auth-mode <mode>                Control-plane auth mode: password or disabled
  --static-dir <path>               Built control-plane UI directory
USAGE
}

need_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "This installer must run as root. Re-run with sudo." >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-dir) REPO_DIR="${2:-}"; shift 2 ;;
    --task-handoff-bin) TASK_HANDOFF_BIN="${2:-}"; shift 2 ;;
    --control-plane-bin) CONTROL_PLANE_BIN="${2:-}"; shift 2 ;;
    --node-agent-bin) NODE_AGENT_BIN="${2:-}"; shift 2 ;;
    --controlled-instance-bin) CONTROLLED_INSTANCE_BIN="${2:-}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:-}"; shift 2 ;;
    --control-plane-data-dir) CONTROL_PLANE_DATA_DIR="${2:-}"; shift 2 ;;
    --node-agent-data-dir) NODE_AGENT_DATA_DIR="${2:-}"; shift 2 ;;
    --control-plane-host) CONTROL_PLANE_HOST="${2:-}"; shift 2 ;;
    --control-plane-port) CONTROL_PLANE_PORT="${2:-}"; shift 2 ;;
    --node-agent-host) NODE_AGENT_HOST="${2:-}"; shift 2 ;;
    --node-agent-port) NODE_AGENT_PORT="${2:-}"; shift 2 ;;
    --node-agent-ipc-path) NODE_AGENT_IPC_PATH="${2:-}"; shift 2 ;;
    --auth-mode) AUTH_MODE="${2:-}"; shift 2 ;;
    --static-dir) STATIC_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

need_root

if [ "$AUTH_MODE" != "password" ] && [ "$AUTH_MODE" != "disabled" ]; then
  echo "--auth-mode must be password or disabled." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required for this installer." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for this installer." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for managed updates." >&2
  exit 1
fi
NPM_COMMAND="$(command -v npm)"

resolve_command() {
  candidate="$1"
  if [ -f "$candidate" ]; then
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
    else
      if ! command -v node >/dev/null 2>&1; then
        echo "node is required to run $candidate." >&2
        exit 1
      fi
      printf '%s %s\n' "$(command -v node)" "$candidate"
    fi
  elif command -v "$candidate" >/dev/null 2>&1; then
    command -v "$candidate"
  else
    echo "TaskHandoff executable was not found: $candidate" >&2
    exit 1
  fi
}

if [ -n "$TASK_HANDOFF_BIN" ]; then
  TASK_HANDOFF_COMMAND="$(resolve_command "$TASK_HANDOFF_BIN")"
elif [ -z "$CONTROL_PLANE_BIN" ] && [ -z "$NODE_AGENT_BIN" ] && [ -z "$CONTROLLED_INSTANCE_BIN" ] && [ -f "$REPO_DIR/bin/task-handoff.js" ]; then
  TASK_HANDOFF_COMMAND="$(resolve_command "$REPO_DIR/bin/task-handoff.js")"
fi

if [ -n "$TASK_HANDOFF_COMMAND" ]; then
  CONTROL_PLANE_COMMAND="$TASK_HANDOFF_COMMAND control-plane"
  NODE_AGENT_COMMAND="$TASK_HANDOFF_COMMAND node-agent"
  CONTROLLED_INSTANCE_COMMAND="$TASK_HANDOFF_COMMAND web"
  if [ -z "$STATIC_DIR" ]; then
    STATIC_DIR="$REPO_DIR/packages/control-plane-ui/dist"
  fi
else
  if [ -z "$CONTROL_PLANE_BIN" ] && [ -f "$INSTALLER_BIN_DIR/task-handoff-control-plane" ]; then
    CONTROL_PLANE_BIN="$INSTALLER_BIN_DIR/task-handoff-control-plane"
  fi
  if [ -z "$NODE_AGENT_BIN" ] && [ -f "$INSTALLER_BIN_DIR/task-handoff-node-agent" ]; then
    NODE_AGENT_BIN="$INSTALLER_BIN_DIR/task-handoff-node-agent"
  fi
  if [ -z "$CONTROLLED_INSTANCE_BIN" ] && [ -f "$INSTALLER_BIN_DIR/task-handoff-controlled-instance" ]; then
    CONTROLLED_INSTANCE_BIN="$INSTALLER_BIN_DIR/task-handoff-controlled-instance"
  fi
  CONTROL_PLANE_COMMAND="$(resolve_command "${CONTROL_PLANE_BIN:-task-handoff-control-plane}")"
  NODE_AGENT_COMMAND="$(resolve_command "${NODE_AGENT_BIN:-task-handoff-node-agent}")"
  CONTROLLED_INSTANCE_COMMAND="$(resolve_command "${CONTROLLED_INSTANCE_BIN:-task-handoff-controlled-instance}") web"
fi

CONTROL_PLANE_STATIC_OPTION=""
if [ -n "$STATIC_DIR" ]; then
  CONTROL_PLANE_STATIC_OPTION="--static-dir $STATIC_DIR"
fi

NODE_AGENT_IPC_ENDPOINT="$(node -e 'process.stdout.write(`ipc://${encodeURIComponent(process.argv[1])}`)' "$NODE_AGENT_IPC_PATH")"

if [ "$SERVICE_USER" != "root" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/task-handoff --shell /usr/sbin/nologin "$SERVICE_USER"
fi
if [ "$SERVICE_USER" != "root" ] && getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$SERVICE_USER" || true
fi

assert_service_command_accessible() {
  command_value="$1"
  command_label="$2"
  executable="${command_value%% *}"
  if [ "$SERVICE_USER" != "root" ] && command -v runuser >/dev/null 2>&1 && ! runuser -u "$SERVICE_USER" -- test -x "$executable"; then
    echo "$command_label is not executable by service user $SERVICE_USER: $executable" >&2
    echo "Install Node.js and TaskHandoff under a system-wide prefix such as /usr/local, not a root-only NVM directory." >&2
    exit 1
  fi
}

assert_service_command_accessible "$CONTROL_PLANE_COMMAND" "Control-plane command"
assert_service_command_accessible "$NODE_AGENT_COMMAND" "Node-agent command"
assert_service_command_accessible "$CONTROLLED_INSTANCE_COMMAND" "Controlled-instance command"
assert_service_command_accessible "$NPM_COMMAND" "npm command"

mkdir -p "$ENV_DIR" "$CONTROL_PLANE_DATA_DIR" "$NODE_AGENT_DATA_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$CONTROL_PLANE_DATA_DIR" "$NODE_AGENT_DATA_DIR" 2>/dev/null || true

cat > "$ENV_DIR/node-agent.env" <<EOF
TASK_HANDOFF_NODE_AGENT_HOST=$NODE_AGENT_HOST
TASK_HANDOFF_NODE_AGENT_PORT=$NODE_AGENT_PORT
TASK_HANDOFF_NODE_AGENT_DATA_DIR=$NODE_AGENT_DATA_DIR
TASK_HANDOFF_NODE_AGENT_CONNECTION_MODE=local-ipc
TASK_HANDOFF_NODE_AGENT_IPC_PATH=$NODE_AGENT_IPC_PATH
TASK_HANDOFF_NODE_AGENT_CONTAINER_URL=http://host.docker.internal:$NODE_AGENT_PORT
TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND=$CONTROLLED_INSTANCE_COMMAND
TASK_HANDOFF_NPM_COMMAND=$NPM_COMMAND
EOF
chmod 0640 "$ENV_DIR/node-agent.env"

cat > "$ENV_DIR/control-plane.env" <<EOF
TASK_HANDOFF_CONTROL_PLANE_HOST=$CONTROL_PLANE_HOST
TASK_HANDOFF_CONTROL_PLANE_PORT=$CONTROL_PLANE_PORT
TASK_HANDOFF_CONTROL_PLANE_DATA_DIR=$CONTROL_PLANE_DATA_DIR
TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR=$STATIC_DIR
TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE=$AUTH_MODE
TASK_HANDOFF_NODE_AGENT_ENDPOINT=http://$NODE_AGENT_HOST:$NODE_AGENT_PORT
TASK_HANDOFF_NODE_AGENT_CONTROL_ENDPOINT=$NODE_AGENT_IPC_ENDPOINT
TASK_HANDOFF_NODE_AGENT_CONTAINER_URL=http://host.docker.internal:$NODE_AGENT_PORT
EOF
chmod 0640 "$ENV_DIR/control-plane.env"

cat > /etc/systemd/system/task-handoff-node-agent.service <<EOF
[Unit]
Description=TaskHandoff Local Node Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$NODE_AGENT_DATA_DIR
RuntimeDirectory=task-handoff
RuntimeDirectoryMode=0700
EnvironmentFile=-$ENV_DIR/node-agent.env
ExecStart=$NODE_AGENT_COMMAND --host $NODE_AGENT_HOST --port $NODE_AGENT_PORT --data-dir $NODE_AGENT_DATA_DIR --connection-mode local-ipc --ipc-path $NODE_AGENT_IPC_PATH
Restart=always
RestartSec=3
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/task-handoff-control-plane.service <<EOF
[Unit]
Description=TaskHandoff Control Plane
After=network-online.target task-handoff-node-agent.service
Wants=network-online.target task-handoff-node-agent.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$CONTROL_PLANE_DATA_DIR
EnvironmentFile=-$ENV_DIR/control-plane.env
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 30); do [ -S "$NODE_AGENT_IPC_PATH" ] && exit 0; sleep 1; done; exit 1'
ExecStart=$CONTROL_PLANE_COMMAND --host $CONTROL_PLANE_HOST --port $CONTROL_PLANE_PORT --data-dir $CONTROL_PLANE_DATA_DIR $CONTROL_PLANE_STATIC_OPTION --auth-mode $AUTH_MODE
Restart=always
RestartSec=3
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now task-handoff-node-agent.service
systemctl enable --now task-handoff-control-plane.service

echo "TaskHandoff server services are installed."
echo "Control plane: task-handoff-control-plane.service on $CONTROL_PLANE_HOST:$CONTROL_PLANE_PORT"
echo "Local node-agent: task-handoff-node-agent.service on $NODE_AGENT_HOST:$NODE_AGENT_PORT"
