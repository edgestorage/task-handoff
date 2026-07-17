FROM node:22-bookworm-slim AS base

ARG CODEX_CLI_PACKAGE=@openai/codex@latest
ARG CLAUDE_CODE_VERSION=2.1.183
ARG CODE_SERVER_VERSION=4.125.0
ARG KASMVNC_VERSION=1.4.0
ARG TASK_HANDOFF_ENABLE_CC_SWITCH=0
ARG CC_SWITCH_VERSION=3.16.3
ARG CC_SWITCH_DEB_URL=
ARG CC_SWITCH_COMMAND=cc-switch
ARG CHROMIUM_EXTENSION_URLS=
ARG CHROMIUM_EXTENSION_IDS=
ARG CHROMIUM_EXTENSION_UPDATE_URL=https://clients2.google.com/service/update2/crx
ARG TASK_HANDOFF_ENABLE_WEB_CAP=0
ARG WEB_CAPABILITY_VERSION=0.0.7
ARG WEB_CAP_EXTENSION_VERSION=0.0.7
ARG WEB_CAP_EXTENSION_URL=
ARG WEB_CAP_SKILL_REPOSITORY=https://github.com/edgestorage/web-cap.git
ARG WEB_CAP_SKILL_REF=v0.0.7
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-web:local
ARG TASK_HANDOFF_IMAGE_DIGEST=

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TASK_HANDOFF_WEB_HOST=0.0.0.0
ENV TASK_HANDOFF_WEB_PORT=8080
ENV TASK_HANDOFF_WORKSPACE=/workspace
ENV TASK_HANDOFF_DATA_DIR=/data/task-handoff
ENV TASK_HANDOFF_APP_CATALOG_DIR=/data/task-handoff/app-catalog
ENV TASK_HANDOFF_ARTIFACT_DIR=/data/artifacts
ENV TASK_HANDOFF_APP_SESSION_DIR=/data/task-handoff/app-sessions
ENV TASK_HANDOFF_RUNTIME_DIR=/data/task-handoff/runtime
ENV TASK_HANDOFF_EVENTS_DIR=/data/task-handoff/events
ENV TASK_HANDOFF_LOG_DIR=/data/logs
ENV TASK_HANDOFF_NOVNC_ROOT=/usr/share/novnc
ENV TASK_HANDOFF_VNC_BACKEND=kasmvnc
ENV TASK_HANDOFF_ENABLE_CC_SWITCH=${TASK_HANDOFF_ENABLE_CC_SWITCH}
ENV TASK_HANDOFF_CC_SWITCH_COMMAND=${CC_SWITCH_COMMAND}
ENV TASK_HANDOFF_CHROMIUM_EXTENSION_DIR=/opt/task-handoff/chromium-extensions
ENV CODEX_HOME=/home/agent/.codex
ENV CLAUDE_HOME=/home/agent/.claude

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    chromium-sandbox \
    curl \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    g++ \
    git \
    imagemagick \
    make \
    novnc \
    openbox \
    picom \
    python3 \
    sudo \
    ssl-cert \
    tini \
    unzip \
    vim \
    websockify \
    x11vnc \
    x11-xserver-utils \
    xterm \
    xvfb \
    zsh \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN if id -u agent >/dev/null 2>&1; then \
    true; \
  elif id -u node >/dev/null 2>&1; then \
    usermod -l agent -d /home/agent -m -s /bin/bash node \
    && groupmod -n agent node; \
  else \
    useradd -m -u 1000 -s /bin/bash agent; \
  fi \
  && mkdir -p /home/agent/.codex /home/agent/.claude \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent
RUN npm_config_update_notifier=false npm install -g --include=optional --no-audit --no-fund --loglevel=warn "$CODEX_CLI_PACKAGE" \
  && codex --version
ARG TARGETOS
ARG TARGETARCH
RUN set -eux; \
  case "${TARGETOS:-linux}-${TARGETARCH:-amd64}" in \
    linux-amd64) code_server_arch="amd64" ;; \
    linux-arm64) code_server_arch="arm64" ;; \
    *) echo "Unsupported code-server Docker target: ${TARGETOS:-linux}-${TARGETARCH:-amd64}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/code-server.deb "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${code_server_arch}.deb"; \
  dpkg -i /tmp/code-server.deb; \
  rm -f /tmp/code-server.deb; \
  code-server --version
RUN set -eux; \
  case "${TARGETOS:-linux}-${TARGETARCH:-amd64}" in \
    linux-amd64) kasmvnc_arch="amd64" ;; \
    linux-arm64) kasmvnc_arch="arm64" ;; \
    *) echo "Unsupported KasmVNC Docker target: ${TARGETOS:-linux}-${TARGETARCH:-amd64}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/kasmvncserver.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${kasmvnc_arch}.deb"; \
  apt-get update; \
  apt-get install -y --no-install-recommends /tmp/kasmvncserver.deb; \
  rm -f /tmp/kasmvncserver.deb; \
  rm -rf /var/lib/apt/lists/*; \
  command -v vncserver; \
  dpkg-query -W kasmvncserver
RUN set -eux; \
  npm_config_update_notifier=false timeout 180s npm install -g --include=optional --no-audit --no-fund --loglevel=verbose \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
  claude --version
COPY docker/optional-apps.sh /tmp/task-handoff-optional-apps.sh
RUN set -eux; \
  . /tmp/task-handoff-optional-apps.sh; \
  set_optional_app_defaults; \
  install_chromium_extensions; \
  if optional_app_enabled "${TASK_HANDOFF_ENABLE_WEB_CAP}"; then \
    git init /tmp/task-handoff-web-cap-source; \
    git -C /tmp/task-handoff-web-cap-source remote add origin "${WEB_CAP_SKILL_REPOSITORY}"; \
    git -C /tmp/task-handoff-web-cap-source sparse-checkout set skills/web-cap; \
    git -C /tmp/task-handoff-web-cap-source fetch --depth 1 origin "${WEB_CAP_SKILL_REF}"; \
    git -C /tmp/task-handoff-web-cap-source checkout --detach FETCH_HEAD; \
    test -f /tmp/task-handoff-web-cap-source/skills/web-cap/SKILL.md; \
    cp -R /tmp/task-handoff-web-cap-source/skills/web-cap /tmp/task-handoff-web-cap-skill; \
    rm -rf /tmp/task-handoff-web-cap-source; \
  fi; \
  install_web_cap; \
  case "${TASK_HANDOFF_ENABLE_CC_SWITCH}" in \
    1|true|TRUE|yes|YES|on|ON) \
      if [ -z "${CC_SWITCH_DEB_URL}" ]; then \
        echo "CC_SWITCH_DEB_URL is required when TASK_HANDOFF_ENABLE_CC_SWITCH=1" >&2; \
        exit 1; \
      fi; \
      curl -fsSL -o /tmp/cc-switch.deb "${CC_SWITCH_DEB_URL}"; \
      apt-get update; \
      apt-get install -y --no-install-recommends /tmp/cc-switch.deb; \
      rm -f /tmp/cc-switch.deb; \
      rm -rf /var/lib/apt/lists/*; \
      command -v "${CC_SWITCH_COMMAND}"; \
      ;; \
    *) \
      echo "Skipping optional cc-switch install."; \
      ;; \
  esac
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/ai-session-runtime/package.json ./packages/ai-session-runtime/package.json
COPY packages/app-runtime/package.json ./packages/app-runtime/package.json
COPY packages/controlled-instance/package.json ./packages/controlled-instance/package.json
COPY packages/control-plane/package.json ./packages/control-plane/package.json
COPY packages/control-plane-ui/package.json ./packages/control-plane-ui/package.json
COPY packages/controlled-instance-ui/package.json ./packages/controlled-instance-ui/package.json
COPY packages/web-theme/package.json ./packages/web-theme/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/controlled-instance-image/package.json ./apps/controlled-instance-image/package.json
COPY apps/control-plane-image/package.json ./apps/control-plane-image/package.json
COPY apps/desktop-shell/package.json ./apps/desktop-shell/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm exec node --test --test-concurrency=1
RUN pnpm run check:controlled-instance
RUN pnpm run runtime:pack:controlled-instance

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build /app/release/npm/artifacts/task-handoff-controlled-instance-[0-9]*.tgz /tmp/
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/task-handoff-controlled-instance-[0-9]*.tgz \
  && rm -f /tmp/task-handoff-controlled-instance-[0-9]*.tgz
COPY docker/entrypoint.sh /usr/local/bin/task-handoff-entrypoint
COPY docker/healthcheck.sh /usr/local/bin/task-handoff-healthcheck

RUN chmod +x /usr/local/bin/task-handoff-entrypoint /usr/local/bin/task-handoff-healthcheck \
  && mkdir -p \
    /workspace \
    /data/task-handoff/app-catalog \
    /data/task-handoff/app-sessions \
    /data/task-handoff/runtime \
    /data/artifacts \
    /data/logs \
    /home/agent/.codex \
    /home/agent/.claude \
  && chown -R agent:agent /workspace /data /home/agent /app
RUN rm -rf /tmp/.X11-unix \
  && mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix

# Keep volatile build metadata after all expensive filesystem layers so a new
# run id or commit does not invalidate system packages and application builds.
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-web:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-entrypoint"]
CMD ["task-handoff", "web"]
