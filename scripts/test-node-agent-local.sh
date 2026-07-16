#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/task-handoff-control-plane.XXXXXX")"
CONTROL_PORT="${TASK_HANDOFF_TEST_CONTROL_PORT:-18081}"
AGENT_PORT="${TASK_HANDOFF_TEST_AGENT_PORT:-18091}"
AGENT_TOKEN="${TASK_HANDOFF_TEST_AGENT_TOKEN:-dev-token}"
IMAGE_REF="${TASK_HANDOFF_TEST_IMAGE:-task-handoff-web:local}"
PULL_IMAGE_REF="${TASK_HANDOFF_TEST_PULL_IMAGE:-alpine:3.20}"
GIT_URL="${TASK_HANDOFF_TEST_GIT_URL:-https://github.com/openai/codex.git}"

CONTROL_PID=""
AGENT_PID=""

cleanup() {
  if [ -n "${CONTROL_PID}" ]; then
    kill "${CONTROL_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${AGENT_PID}" ]; then
    kill "${AGENT_PID}" >/dev/null 2>&1 || true
  fi
  rm -rf "${DATA_DIR}"
}
trap cleanup EXIT

node "${ROOT_DIR}/bin/task-handoff.js" control-plane \
  --host 127.0.0.1 \
  --port "${CONTROL_PORT}" \
  --data-dir "${DATA_DIR}" >/tmp/task-handoff-control-plane-test.log 2>&1 &
CONTROL_PID="$!"

node "${ROOT_DIR}/bin/task-handoff.js" node-agent \
  --host 127.0.0.1 \
  --port "${AGENT_PORT}" \
  --data-dir "${DATA_DIR}/node-agent" \
  --token "${AGENT_TOKEN}" >/tmp/task-handoff-node-agent-test.log 2>&1 &
AGENT_PID="$!"

wait_for() {
  local url="$1"
  for _ in $(seq 1 80); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for ${url}" >&2
  return 1
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [ -n "${body}" ]; then
    curl -fsS -X "${method}" \
      -H "content-type: application/json" \
      --data "${body}" \
      "http://127.0.0.1:${CONTROL_PORT}/api/${path}"
  else
    curl -fsS -X "${method}" "http://127.0.0.1:${CONTROL_PORT}/api/${path}"
  fi
}

json_get() {
  node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const value = JSON.parse(data); console.log(${1}); });"
}

wait_for_instance_status() {
  local instance_id="$1"
  local expected="$2"
  for _ in $(seq 1 240); do
    local status
    status="$(api GET "controlled-instances/${instance_id}" | json_get "value.data.status")"
    if [ "${status}" = "${expected}" ]; then
      return 0
    fi
    if [ "${status}" = "failed" ]; then
      api GET "controlled-instances/${instance_id}" >&2
      return 1
    fi
    sleep 0.25
  done
  echo "Timed out waiting for instance ${instance_id} to reach ${expected}" >&2
  return 1
}

wait_for_managed_app_state() {
  local instance_id="$1"
  local app_id="$2"
  local expected="$3"
  for _ in $(seq 1 240); do
    local response state
    if response="$(api GET "controlled-instances/${instance_id}/apps/management" 2>/dev/null)"; then
      state="$(printf '%s' "${response}" | json_get "value.data.apps.find(app => app.id === '${app_id}')?.state || ''")"
      if [ "${state}" = "${expected}" ]; then
        return 0
      fi
    fi
    sleep 0.25
  done
  echo "Timed out waiting for managed app ${app_id} to reach ${expected}" >&2
  return 1
}

wait_for_app_job() {
  local instance_id="$1"
  local job_id="$2"
  for _ in $(seq 1 240); do
    local response state
    response="$(api GET "controlled-instances/${instance_id}/apps/jobs/${job_id}")"
    state="$(printf '%s' "${response}" | json_get "value.data.job.state")"
    case "${state}" in
      succeeded) return 0 ;;
      failed|cancelled|interrupted)
        printf '%s\n' "${response}" >&2
        return 1
        ;;
    esac
    sleep 0.25
  done
  echo "Timed out waiting for managed app job ${job_id}" >&2
  return 1
}

wait_for "http://127.0.0.1:${CONTROL_PORT}/api/health"
for _ in $(seq 1 80); do
  if curl -fsS -H "authorization: Bearer ${AGENT_TOKEN}" "http://127.0.0.1:${AGENT_PORT}/api/node-agent/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS -H "authorization: Bearer ${AGENT_TOKEN}" "http://127.0.0.1:${AGENT_PORT}/api/node-agent/health" >/dev/null

JOIN_TOKEN="$(curl -fsS -X POST \
  -H "authorization: Bearer ${AGENT_TOKEN}" \
  -H "content-type: application/json" \
  --data '{"controlPlaneName":"Local Smoke Control Plane"}' \
  "http://127.0.0.1:${AGENT_PORT}/api/node-agent/pairing/invites" | json_get "value.data.joinToken")"
NODE_ID="$(api POST nodes "{\"name\":\"Local Node Agent\",\"connectionMode\":\"direct-http\",\"endpoint\":\"http://127.0.0.1:${AGENT_PORT}\",\"joinToken\":\"${JOIN_TOKEN}\"}" | json_get "value.data.id")"
RUNTIME_ID="$(api GET "nodes/${NODE_ID}/runtimes" | json_get "value.data[0].id")"
PROJECT_ID="$(api POST projects "{\"name\":\"Node Agent Git Project\",\"source\":{\"type\":\"git-repository\",\"url\":\"${GIT_URL}\"},\"defaultNodeId\":\"${NODE_ID}\",\"defaultRuntimeId\":\"${RUNTIME_ID}\"}" | json_get "value.data.id")"
IMAGE_ID="$(api POST images "{\"name\":\"${IMAGE_REF}\",\"reference\":\"${IMAGE_REF}\",\"pullPolicy\":\"if-not-present\",\"capabilities\":[\"browser\",\"terminal\"],\"optionalApps\":[\"terminal-tty\"],\"defaultEnv\":{},\"labels\":{}}" | json_get "value.data.id")"
INSTANCE_ID="$(api POST controlled-instances "{\"name\":\"node-agent-smoke\",\"projectId\":\"${PROJECT_ID}\",\"nodeId\":\"${NODE_ID}\",\"runtimeId\":\"${RUNTIME_ID}\",\"imageId\":\"${IMAGE_ID}\"}" | json_get "value.data.id")"
PULL_IMAGE_ID="$(api POST images "{\"name\":\"${PULL_IMAGE_REF}\",\"reference\":\"${PULL_IMAGE_REF}\",\"pullPolicy\":\"if-not-present\",\"capabilities\":[],\"optionalApps\":[],\"defaultEnv\":{},\"labels\":{}}" | json_get "value.data.id")"
PULL_INSTANCE_ID="$(api POST controlled-instances "{\"name\":\"node-agent-pull-smoke\",\"projectId\":\"${PROJECT_ID}\",\"nodeId\":\"${NODE_ID}\",\"runtimeId\":\"${RUNTIME_ID}\",\"imageId\":\"${PULL_IMAGE_ID}\"}" | json_get "value.data.id")"

api POST "nodes/${NODE_ID}/check" >/dev/null
api GET "nodes/${NODE_ID}/docker/images" >/dev/null
wait_for_instance_status "${INSTANCE_ID}" created
wait_for_instance_status "${PULL_INSTANCE_ID}" created
api POST "controlled-instances/${INSTANCE_ID}/start" >/dev/null
wait_for_instance_status "${INSTANCE_ID}" running

wait_for_managed_app_state "${INSTANCE_ID}" terminal-gui installed
UNINSTALL_JOB_ID="$(api POST "controlled-instances/${INSTANCE_ID}/apps/terminal-gui/uninstall" '{}' | json_get "value.data.job.id")"
wait_for_app_job "${INSTANCE_ID}" "${UNINSTALL_JOB_ID}"
wait_for_managed_app_state "${INSTANCE_ID}" terminal-gui not-installed
INSTALL_JOB_ID="$(api POST "controlled-instances/${INSTANCE_ID}/apps/terminal-gui/install" '{}' | json_get "value.data.job.id")"
wait_for_app_job "${INSTANCE_ID}" "${INSTALL_JOB_ID}"
wait_for_managed_app_state "${INSTANCE_ID}" terminal-gui installed

api GET instance-board | json_get "JSON.stringify(value.data.map(item => ({ id: item.id, status: item.status, connectionStatus: item.connectionStatus, web: item.endpoints.web })))"
printf 'managed app loop: terminal-gui installed -> not-installed -> installed\n'
