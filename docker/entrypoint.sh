#!/usr/bin/env bash
set -euo pipefail

load_private_config() {
  local config_path="/run/task-handoff/instance-private-config.json"
  if [ ! -f "${config_path}" ]; then
    echo "Managed instance private configuration is missing." >&2
    exit 78
  fi
  while IFS=$'\t' read -r key encoded; do
    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Managed instance private configuration contains an invalid environment key." >&2
      exit 78
    fi
    local value
    value="$(printf '%s' "${encoded}" | base64 --decode)"
    export "${key}=${value}"
  done < <(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.version !== 1 || typeof value.instanceCredential !== "string" || !value.instanceCredential || !value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)) process.exit(78);
    const environment = { ...value.environment, TASK_HANDOFF_REGISTRATION_TOKEN: value.instanceCredential, TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1" };
    for (const [key, item] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string") process.exit(78);
      process.stdout.write(`${key}\t${Buffer.from(item).toString("base64")}\n`);
    }
  ' "${config_path}")
  if [ "${TASK_HANDOFF_PRIVATE_CONFIG_LOADED:-}" != "1" ]; then
    echo "Managed instance private configuration is invalid." >&2
    exit 78
  fi
}

if [ -n "${TASK_HANDOFF_WORKSPACE_SUBDIRECTORY:-}" ]; then
  export TASK_HANDOFF_WORKSPACE="${TASK_HANDOFF_WORKSPACE:-/workspace}/${TASK_HANDOFF_WORKSPACE_SUBDIRECTORY}"
  unset TASK_HANDOFF_WORKSPACE_SUBDIRECTORY
fi

if [ "$(id -u)" = "0" ] && [ "${TASK_HANDOFF_PRIVILEGE_DROPPED:-0}" != "1" ]; then
  load_private_config
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
  local git_url="${TASK_HANDOFF_GIT_URL:-}"
  local git_ref="${TASK_HANDOFF_GIT_REF:-}"

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
  if [ -n "${TASK_HANDOFF_GIT_DEPTH:-}" ]; then
    clone_args+=(--depth "${TASK_HANDOFF_GIT_DEPTH}")
  fi
  if [ "${TASK_HANDOFF_GIT_SUBMODULES:-false}" = "true" ]; then
    clone_args+=(--recurse-submodules)
  fi
  if [ -n "${git_ref}" ]; then
    clone_args+=(--branch "${git_ref}")
  fi
  clone_args+=("${git_url}" "${workspace}")

  echo "Cloning workspace ${git_url} into ${workspace}."
  git "${clone_args[@]}"

  if [ -n "${TASK_HANDOFF_GIT_COMMIT:-}" ]; then
    git -C "${workspace}" checkout "${TASK_HANDOFF_GIT_COMMIT}"
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
