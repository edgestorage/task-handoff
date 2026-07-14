#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/task-handoff-control-plane.XXXXXX")"
CONTROL_PORT="${TASK_HANDOFF_TEST_CONTROL_PORT:-18081}"
AGENT_PORT="${TASK_HANDOFF_TEST_AGENT_PORT:-18091}"
AGENT_TOKEN="${TASK_HANDOFF_TEST_AGENT_TOKEN:-dev-token}"
IMAGE_REF="${TASK_HANDOFF_TEST_IMAGE:-task-handoff-web:local}"
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
  --public-host 127.0.0.1 \
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

wait_for "http://127.0.0.1:${CONTROL_PORT}/api/health"
for _ in $(seq 1 80); do
  if curl -fsS -H "authorization: Bearer ${AGENT_TOKEN}" "http://127.0.0.1:${AGENT_PORT}/api/node-agent/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS -H "authorization: Bearer ${AGENT_TOKEN}" "http://127.0.0.1:${AGENT_PORT}/api/node-agent/health" >/dev/null

NODE_ID="$(api POST nodes "{\"name\":\"Local Node Agent\",\"connectionMode\":\"direct-http\",\"endpoint\":\"http://127.0.0.1:${AGENT_PORT}\",\"labels\":{\"task-handoff.node-agent.token\":\"${AGENT_TOKEN}\"}}" | json_get "value.data.id")"
RUNTIME_ID="$(api GET "nodes/${NODE_ID}/runtimes" | json_get "value.data[0].id")"
PROJECT_ID="$(api POST projects "{\"name\":\"Node Agent Git Project\",\"source\":{\"type\":\"git-repository\",\"url\":\"${GIT_URL}\"},\"defaultNodeId\":\"${NODE_ID}\",\"defaultRuntimeId\":\"${RUNTIME_ID}\"}" | json_get "value.data.id")"
IMAGE_ID="$(api POST images "{\"name\":\"${IMAGE_REF}\",\"image\":\"${IMAGE_REF}\",\"registry\":\"local\",\"capabilities\":[\"browser\",\"terminal\"],\"optionalApps\":[\"terminal-tty\"],\"defaultEnv\":{},\"labels\":{}}" | json_get "value.data.id")"
INSTANCE_ID="$(api POST controlled-instances "{\"name\":\"node-agent-smoke\",\"projectId\":\"${PROJECT_ID}\",\"nodeId\":\"${NODE_ID}\",\"runtimeId\":\"${RUNTIME_ID}\",\"imageId\":\"${IMAGE_ID}\"}" | json_get "value.data.id")"

api POST "nodes/${NODE_ID}/check" >/dev/null
api GET "nodes/${NODE_ID}/docker/images" >/dev/null
api POST "controlled-instances/${INSTANCE_ID}/start" >/dev/null

api GET instance-board | json_get "JSON.stringify(value.data.map(item => ({ id: item.id, status: item.status, connectionStatus: item.connectionStatus, web: item.endpoints.web })))"
