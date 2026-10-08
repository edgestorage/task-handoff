#!/usr/bin/env bash
set -euo pipefail

# The private config is mounted as a per-instance directory.
readonly private_config_default_path="/run/task-handoff/private/private-config.json"

resolve_private_config_path() {
  local candidate
  for candidate in "${TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH:-}" "${private_config_default_path}"; do
    if [ -n "${candidate}" ] && [ -f "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

# Only the instance identity is required to start. Model environment, catalog,
# and Codex settings are an optional startup snapshot that the node agent pushes
# over the authenticated internal API once the instance is registered.
decode_private_config() {
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.version !== 1 || typeof value.instanceId !== "string" || !value.instanceId || typeof value.instanceCredential !== "string" || !value.instanceCredential) process.exit(78);
    const configured = value.environment === undefined ? {} : value.environment;
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) process.exit(78);
    const environment = { ...configured, TASK_HANDOFF_REGISTRATION_TOKEN: value.instanceCredential, TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1", TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: process.argv[1] };
    if (value.modelCatalog !== undefined) environment.TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON = JSON.stringify(value.modelCatalog);
    if (value.codexSettings !== undefined) environment.TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON = JSON.stringify(value.codexSettings);
    for (const [key, item] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string") process.exit(78);
      process.stdout.write(`${key}\t${Buffer.from(item).toString("base64")}\n`);
    }
  ' "$1"
}

load_private_config() {
  local attempts="${TASK_HANDOFF_PRIVATE_CONFIG_RETRY_ATTEMPTS:-20}"
  local delay_seconds="${TASK_HANDOFF_PRIVATE_CONFIG_RETRY_DELAY_SECONDS:-1}"
  local attempt=1
  local config_path decoded key encoded value
  while :; do
    if config_path="$(resolve_private_config_path)" && decoded="$(decode_private_config "${config_path}")"; then
      while IFS=$'\t' read -r key encoded; do
        if [ -z "${key}" ]; then
          continue
        fi
        if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
          echo "Managed instance private configuration contains an invalid environment key." >&2
          exit 78
        fi
        value="$(printf '%s' "${encoded}" | base64 --decode)"
        export "${key}=${value}"
      done <<< "${decoded}"
      if [ "${TASK_HANDOFF_PRIVATE_CONFIG_LOADED:-}" = "1" ]; then
        return 0
      fi
      echo "Managed instance private configuration could not be applied." >&2
      exit 78
    fi
    if [ "${attempt}" -ge "${attempts}" ]; then
      break
    fi
    attempt=$((attempt + 1))
    sleep "${delay_seconds}"
  done
  echo "Managed instance private configuration is missing or invalid after ${attempts} attempts." >&2
  exit 78
}

start_node_agent_unix_proxy() {
  if [ -z "${TASK_HANDOFF_NODE_AGENT_SOCKET_PATH:-}" ]; then
    return
  fi
  node /run/task-handoff/bootstrap/node-agent-unix-proxy.mjs \
    "${TASK_HANDOFF_NODE_AGENT_SOCKET_PATH}" \
    "${TASK_HANDOFF_NODE_AGENT_PROXY_PORT:-19001}" &
}

if [ -n "${TASK_HANDOFF_WORKSPACE_SUBDIRECTORY:-}" ]; then
  export TASK_HANDOFF_WORKSPACE="${TASK_HANDOFF_WORKSPACE:-/workspace}/${TASK_HANDOFF_WORKSPACE_SUBDIRECTORY}"
  unset TASK_HANDOFF_WORKSPACE_SUBDIRECTORY
fi

if [ "$(id -u)" = "0" ] && [ "${TASK_HANDOFF_PRIVILEGE_DROPPED:-0}" != "1" ]; then
  load_private_config
  start_node_agent_unix_proxy
  mkdir -p /data /home/agent
  chown agent:agent /data /home/agent
  if [ "${TASK_HANDOFF_WORKSPACE_MODE:-}" = "git-clone" ]; then
    mkdir -p "${TASK_HANDOFF_WORKSPACE:-/workspace}"
    chown agent:agent "${TASK_HANDOFF_WORKSPACE:-/workspace}"
  fi
  export TASK_HANDOFF_PRIVILEGE_DROPPED=1
  exec sudo --preserve-env --set-home -u agent -- bash "$0" "$@"
fi

mkdir -p \
  "${TASK_HANDOFF_DATA_DIR:-/data/task-handoff}" \
  "${TASK_HANDOFF_APP_CATALOG_DIR:-/data/task-handoff/app-catalog}" \
  "${TASK_HANDOFF_APP_SESSION_DIR:-/data/task-handoff/app-sessions}" \
  "${TASK_HANDOFF_RUNTIME_DIR:-/data/task-handoff/runtime}" \
  "${TASK_HANDOFF_EVENTS_DIR:-/data/task-handoff/events}" \
  "${TASK_HANDOFF_ARTIFACT_DIR:-/data/artifacts}" \
  "${TASK_HANDOFF_LOG_DIR:-/data/logs}" \
  "${CODEX_HOME:-/home/agent/.codex}" \
  "${CLAUDE_HOME:-/home/agent/.claude}" \
  "${TASK_HANDOFF_WORKSPACE:-/workspace}"

bootstrap_workspace() {
  if [ "${TASK_HANDOFF_SKIP_WORKSPACE_BOOTSTRAP:-false}" = "true" ]; then
    return
  fi
  local workspace="${TASK_HANDOFF_WORKSPACE:-/workspace}"
  local mode="${TASK_HANDOFF_WORKSPACE_MODE:-}"
  # Workspace Git environment contract (mirrors @task-handoff/protocol/workspace-git).
  # This script is mounted by the node agent that writes the environment, so the
  # workspace keys are the only input. The legacy keys are never read: images
  # bake TASK_HANDOFF_GIT_COMMIT as their build commit and docker run exposes
  # image environment here.
  local git_url="${TASK_HANDOFF_WORKSPACE_GIT_URL:-}"
  local git_ref="${TASK_HANDOFF_WORKSPACE_GIT_REF:-}"
  local git_depth="${TASK_HANDOFF_WORKSPACE_GIT_DEPTH:-}"
  local git_submodules="${TASK_HANDOFF_WORKSPACE_GIT_SUBMODULES:-false}"

  if [ "${mode}" != "git-clone" ] || [ -z "${git_url}" ]; then
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "Git workspace bootstrap requested, but git is not installed." >&2
    return 1
  fi

  mkdir -p "${workspace}"
  if [ -n "$(find "${workspace}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    echo "Workspace ${workspace} is not empty; skipping git clone."
    return
  fi

  local clone_args=(clone)
  if [ -n "${git_depth}" ]; then
    clone_args+=(--depth "${git_depth}")
  fi
  if [ "${git_submodules}" = "true" ]; then
    clone_args+=(--recurse-submodules)
  fi
  if [ -n "${git_ref}" ]; then
    clone_args+=(--branch "${git_ref}")
  fi
  clone_args+=("${git_url}" "${workspace}")

  echo "Cloning workspace ${git_url} into ${workspace}."
  git "${clone_args[@]}"

  if [ -n "${TASK_HANDOFF_WORKSPACE_GIT_COMMIT:-}" ]; then
    git -C "${workspace}" checkout "${TASK_HANDOFF_WORKSPACE_GIT_COMMIT}"
  fi
}

if command -v web-cap >/dev/null 2>&1 && [ -d /tmp/task-handoff-web-cap-skill ]; then
  for skills_dir in \
    /home/agent/.agents/skills \
    "${CODEX_HOME:-/home/agent/.codex}/skills" \
    "${CLAUDE_HOME:-/home/agent/.claude}/skills"
  do
    rm -rf "${skills_dir}/web-cap"
    mkdir -p "${skills_dir}"
    cp -R /tmp/task-handoff-web-cap-skill "${skills_dir}/web-cap"
  done
fi

start_web_cap_daemon() {
  if ! command -v web-cap >/dev/null 2>&1; then
    return
  fi

  local log_file="${TASK_HANDOFF_LOG_DIR:-/data/logs}/web-cap-daemon.log"
  local idle_timeout="${WEB_CAP_DAEMON_IDLE_TIMEOUT_MS:-0}"

  if WEB_CAP_DAEMON_IDLE_TIMEOUT_MS="${idle_timeout}" timeout 15s web-cap session-status >"${log_file}" 2>&1; then
    echo "Web Cap daemon startup probe completed."
  else
    echo "Web Cap daemon startup probe failed; see ${log_file}."
  fi
}

if [ "${1:-}" = "task-handoff" ] && [ "${2:-}" = "web" ]; then
  bootstrap_workspace
  start_web_cap_daemon
  if [ -n "${TASK_HANDOFF_INSTANCE_LAUNCHER:-}" ]; then
    exec bash "${TASK_HANDOFF_INSTANCE_LAUNCHER}"
  fi
  exec task-handoff-instance-launcher
fi

if [ "${1:-}" = "task-handoff" ]; then
  shift
  if [ "$#" -eq 0 ] || { [ "${1:-}" = "web" ] && [ "$#" -eq 1 ]; }; then
    if [ -n "${TASK_HANDOFF_INSTANCE_LAUNCHER:-}" ]; then
      exec bash "${TASK_HANDOFF_INSTANCE_LAUNCHER}"
    fi
    exec task-handoff-instance-launcher
  fi
  echo "Managed container commands must be launched through the active controlled-instance runtime." >&2
  exit 64
fi

exec "$@"
