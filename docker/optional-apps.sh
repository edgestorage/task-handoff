#!/bin/sh

set_optional_app_defaults() {
  target_os="${TARGETOS:-linux}"
  target_arch="${TARGETARCH:-amd64}"

  : "${CC_SWITCH_VERSION:=3.16.3}"
  case "${target_os}-${target_arch}" in
    linux-amd64)
      : "${CC_SWITCH_DEB_URL:=https://github.com/farion1231/cc-switch/releases/download/v${CC_SWITCH_VERSION}/CC-Switch-v${CC_SWITCH_VERSION}-Linux-x86_64.deb}"
      ;;
    linux-arm64)
      : "${CC_SWITCH_DEB_URL:=https://github.com/farion1231/cc-switch/releases/download/v${CC_SWITCH_VERSION}/CC-Switch-v${CC_SWITCH_VERSION}-Linux-arm64.deb}"
      ;;
    *)
      : "${CC_SWITCH_DEB_URL:=}"
      ;;
  esac

  export CC_SWITCH_VERSION CC_SWITCH_DEB_URL
}

optional_app_enabled() {
  case "${1:-0}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

install_chromium_extension_archive() {
  extension_url="$1"
  target="$2"
  archive="$3"

  rm -rf "${target}"
  mkdir -p "${target}"
  curl -fsSL -o "${archive}" "${extension_url}"
  case "${extension_url}" in
    *.tar.gz|*.tgz)
      tar -xzf "${archive}" -C "${target}"
      ;;
    *.zip)
      unzip -q "${archive}" -d "${target}"
      ;;
    *)
      if unzip -tq "${archive}" >/dev/null 2>&1; then
        unzip -q "${archive}" -d "${target}"
      elif tar -tzf "${archive}" >/dev/null 2>&1; then
        tar -xzf "${archive}" -C "${target}"
      else
        echo "Unsupported Chromium extension archive: ${extension_url}" >&2
        exit 1
      fi
      ;;
  esac
  rm -f "${archive}"

  if [ ! -f "${target}/manifest.json" ]; then
    manifest_path="$(find "${target}" -mindepth 1 -maxdepth 4 -type f -name manifest.json -print -quit)"
    if [ -n "${manifest_path}" ]; then
      manifest_dir="$(dirname "${manifest_path}")"
      normalized="${target}.normalized"
      mkdir -p "${normalized}"
      mv "${manifest_dir}"/* "${normalized}/"
      rm -rf "${target}"
      mv "${normalized}" "${target}"
    fi
  fi

  if [ ! -f "${target}/manifest.json" ]; then
    echo "Chromium extension archive does not contain a manifest.json: ${extension_url}" >&2
    exit 1
  fi
}

install_chromium_extensions() {
  extension_dir="${TASK_HANDOFF_CHROMIUM_EXTENSION_DIR:-/opt/task-handoff/chromium-extensions}"
  extension_urls="$(printf "%s" "${CHROMIUM_EXTENSION_URLS:-}" | tr ',\n' '  ')"

  if [ -n "${extension_urls}" ]; then
    rm -rf "${extension_dir}"
    mkdir -p "${extension_dir}"
    index=0
    for extension_url in ${extension_urls}; do
      index=$((index + 1))
      install_chromium_extension_archive "${extension_url}" "${extension_dir}/extension-${index}" "/tmp/task-handoff-chromium-extension-${index}"
    done
  fi

  if [ -n "${CHROMIUM_EXTENSION_IDS:-}" ]; then
    mkdir -p /etc/chromium/policies/managed
    export CHROMIUM_EXTENSION_IDS CHROMIUM_EXTENSION_UPDATE_URL
    node <<'NODE'
const fs = require("node:fs");
const ids = (process.env.CHROMIUM_EXTENSION_IDS || "")
  .split(/[\s,]+/)
  .map((id) => id.trim())
  .filter(Boolean);
const updateUrl = process.env.CHROMIUM_EXTENSION_UPDATE_URL || "https://clients2.google.com/service/update2/crx";
for (const id of ids) {
  if (!/^[a-p]{32}$/.test(id)) {
    throw new Error(`Invalid Chromium extension id: ${id}`);
  }
}
fs.writeFileSync(
  "/etc/chromium/policies/managed/task-handoff-extensions.json",
  `${JSON.stringify({ ExtensionInstallForcelist: ids.map((id) => `${id};${updateUrl}`) }, null, 2)}\n`,
);
NODE
  fi
}

install_web_cap() {
  extension_dir="${TASK_HANDOFF_CHROMIUM_EXTENSION_DIR:-/opt/task-handoff/chromium-extensions}"
  : "${WEB_CAPABILITY_VERSION:=0.0.7}"
  : "${WEB_CAP_EXTENSION_VERSION:=${WEB_CAPABILITY_VERSION}}"
  : "${WEB_CAP_EXTENSION_URL:=https://github.com/edgestorage/web-cap/releases/download/v${WEB_CAP_EXTENSION_VERSION}/web-capability-extension-${WEB_CAP_EXTENSION_VERSION}-chrome.zip}"

  npm_config_update_notifier=false npm install -g --no-audit --no-fund --loglevel=warn "web-capability@${WEB_CAPABILITY_VERSION}"
  command -v web-cap
  web-cap --version || web-cap --help

  install_chromium_extension_archive "${WEB_CAP_EXTENSION_URL}" "${extension_dir}/web-cap" /tmp/task-handoff-web-cap-extension.zip

  if [ ! -d /tmp/task-handoff-web-cap-skill ]; then
    echo "Web Cap skill source is missing." >&2
    exit 1
  fi
  for skills_dir in \
    /home/agent/.agents/skills \
    /home/agent/.codex/skills \
    /home/agent/.claude/skills
  do
    rm -rf "${skills_dir}/web-cap"
    mkdir -p "${skills_dir}"
    cp -R /tmp/task-handoff-web-cap-skill "${skills_dir}/web-cap"
  done
  chown -R agent:agent /home/agent/.agents /home/agent/.codex /home/agent/.claude
}
