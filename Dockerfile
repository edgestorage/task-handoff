FROM node:24-bookworm-slim AS build-base

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
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    g++ \
    git \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

FROM build-base AS deps
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
RUN pnpm install --frozen-lockfile --config.auto-install-peers=false

FROM deps AS build
ARG TASK_HANDOFF_VERSION=0.0.1
COPY . .
RUN pnpm run check:controlled-instance
RUN TASK_HANDOFF_VERSION="${TASK_HANDOFF_VERSION}" pnpm run runtime:pack:controlled-instance

FROM node:24-bookworm-slim AS runtime-base
ARG TASK_HANDOFF_VERSION=0.0.1

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV TASK_HANDOFF_VERSION=${TASK_HANDOFF_VERSION}
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
ENV TASK_HANDOFF_CHROMIUM_EXTENSION_DIR=/opt/task-handoff/chromium-extensions
ENV CODEX_HOME=/home/agent/.codex
ENV CLAUDE_HOME=/home/agent/.claude
ENV NODE_ENV=production
ENV TASK_HANDOFF_INSTANCE_RUNTIME_ROOT=/opt/task-handoff/instance-runtime

LABEL org.opencontainers.image.version=${TASK_HANDOFF_VERSION}
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    python3 \
    sudo \
    tini \
    vim \
    zsh \
  && rm -rf /var/lib/apt/lists/*
RUN if id -u agent >/dev/null 2>&1; then \
    true; \
  elif id -u node >/dev/null 2>&1; then \
    usermod -l agent -d /home/agent -m -s /bin/bash node \
    && groupmod -n agent node; \
  else \
    useradd -m -u 1000 -s /bin/bash agent; \
  fi \
  && mkdir -p /home/agent/.codex /home/agent/.claude \
  && printf 'agent ALL=(root) NOPASSWD: ALL\n' > /etc/sudoers.d/task-handoff-agent \
  && chmod 0440 /etc/sudoers.d/task-handoff-agent \
  && visudo -cf /etc/sudoers.d/task-handoff-agent

FROM runtime-base AS runtime-package-install
COPY --from=build /app/release/npm/artifacts/task-handoff-controlled-instance-[0-9]*.tgz /tmp/
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/task-handoff-controlled-instance-[0-9]*.tgz \
  && rm -f /tmp/task-handoff-controlled-instance-[0-9]*.tgz

FROM runtime-base AS runtime-core
COPY --from=runtime-package-install /usr/local/lib/node_modules/@task-handoff/controlled-instance /usr/local/lib/node_modules/@task-handoff/controlled-instance
RUN ln -s ../lib/node_modules/@task-handoff/controlled-instance/bin/task-handoff-controlled-instance /usr/local/bin/task-handoff-controlled-instance
COPY docker/entrypoint.sh /usr/local/bin/task-handoff-entrypoint
COPY docker/instance-launcher.sh /usr/local/bin/task-handoff-instance-launcher
COPY docker/runtime-installer.mjs /usr/local/lib/task-handoff/runtime-installer.mjs
COPY docker/healthcheck.sh /usr/local/bin/task-handoff-healthcheck

RUN chmod +x /usr/local/bin/task-handoff-entrypoint /usr/local/bin/task-handoff-instance-launcher /usr/local/lib/task-handoff/runtime-installer.mjs /usr/local/bin/task-handoff-healthcheck \
  && ln -s /usr/local/lib/task-handoff/runtime-installer.mjs /usr/local/bin/task-handoff-runtime \
  && mkdir -p \
    /workspace \
    /data/task-handoff/app-catalog \
    /data/task-handoff/app-sessions \
    /data/task-handoff/runtime \
    /opt/task-handoff/instance-runtime/releases \
    /opt/task-handoff/instance-runtime/staging \
    /data/artifacts \
    /data/logs \
    /home/agent/.codex \
    /home/agent/.claude \
  && chown -R agent:agent /workspace /data /home/agent /app \
  && chmod 0755 /opt/task-handoff/instance-runtime /opt/task-handoff/instance-runtime/releases /opt/task-handoff/instance-runtime/staging
RUN rm -rf /tmp/.X11-unix \
  && mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix

# Install profile layers before volatile metadata so profile builds share all
# expensive application, CLI, and system package layers.
FROM runtime-core AS profile-codex-root
ARG CODEX_CLI_PACKAGE=@openai/codex@latest
RUN npm_config_update_notifier=false npm install -g --include=optional --no-audit --no-fund --loglevel=warn "$CODEX_CLI_PACKAGE" \
  && codex --version

FROM profile-codex-root AS profile-ai-root
ARG CLAUDE_CODE_VERSION=2.1.183
RUN set -eux; \
  npm_config_update_notifier=false timeout 180s npm install -g --include=optional --no-audit --no-fund --loglevel=verbose \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
  claude --version

FROM profile-ai-root AS profile-gui-root
ARG KASMVNC_VERSION=1.4.0
ARG TARGETOS
ARG TARGETARCH
ARG TASK_HANDOFF_ENABLE_CC_SWITCH=0
ARG CC_SWITCH_VERSION=3.16.3
ARG CC_SWITCH_DEB_URL=
ARG CC_SWITCH_COMMAND=cc-switch
ARG CHROMIUM_EXTENSION_URLS=
ARG CHROMIUM_EXTENSION_IDS=
ARG CHROMIUM_EXTENSION_UPDATE_URL=https://clients2.google.com/service/update2/crx
ARG WEB_CAPABILITY_VERSION=0.0.7
ARG WEB_CAP_EXTENSION_VERSION=0.0.7
ARG WEB_CAP_EXTENSION_URL=
ARG WEB_CAP_SKILL_REPOSITORY=https://github.com/edgestorage/web-cap.git
ARG WEB_CAP_SKILL_REF=v0.0.7

ENV TASK_HANDOFF_ENABLE_CC_SWITCH=${TASK_HANDOFF_ENABLE_CC_SWITCH}
ENV TASK_HANDOFF_CC_SWITCH_COMMAND=${CC_SWITCH_COMMAND}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    imagemagick \
    novnc \
    openbox \
    picom \
    ssl-cert \
    unzip \
    websockify \
    x11vnc \
    x11-xserver-utils \
    xterm \
    xz-utils \
    xvfb \
  && rm -rf /var/lib/apt/lists/*
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
COPY docker/optional-apps.sh /tmp/task-handoff-optional-apps.sh
RUN set -eux; \
  . /tmp/task-handoff-optional-apps.sh; \
  set_optional_app_defaults; \
  install_chromium_extensions; \
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

FROM profile-gui-root AS profile-webcap-root
RUN set -eux; \
  git init /tmp/task-handoff-web-cap-source; \
  git -C /tmp/task-handoff-web-cap-source remote add origin "${WEB_CAP_SKILL_REPOSITORY}"; \
  git -C /tmp/task-handoff-web-cap-source sparse-checkout set skills/web-cap; \
  git -C /tmp/task-handoff-web-cap-source fetch --depth 1 origin "${WEB_CAP_SKILL_REF}"; \
  git -C /tmp/task-handoff-web-cap-source checkout --detach FETCH_HEAD; \
  test -f /tmp/task-handoff-web-cap-source/skills/web-cap/SKILL.md; \
  cp -R /tmp/task-handoff-web-cap-source/skills/web-cap /tmp/task-handoff-web-cap-skill; \
  rm -rf /tmp/task-handoff-web-cap-source; \
  . /tmp/task-handoff-optional-apps.sh; \
  install_web_cap

FROM profile-gui-root AS profile-browser-root
ARG CODE_SERVER_VERSION=4.125.0
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

# Each exported target has its own immutable profile declaration and build
# identity while inheriting the shared filesystem layers above.
FROM profile-codex-root AS profile-codex
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-codex:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_IMAGE_PROFILE=codex
ENV TASK_HANDOFF_IMAGE_CAPABILITIES=terminal,codex
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=codex
LABEL io.task-handoff.image.capabilities=terminal,codex

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-ai-root AS profile-ai
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-ai:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_IMAGE_PROFILE=ai
ENV TASK_HANDOFF_IMAGE_CAPABILITIES=terminal,codex,claude
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=ai
LABEL io.task-handoff.image.capabilities=terminal,codex,claude

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-webcap-root AS profile-webcap
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-webcap:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_IMAGE_PROFILE=webcap
ENV TASK_HANDOFF_IMAGE_CAPABILITIES=terminal,gui-terminal,browser,web-cap,codex,claude
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=webcap
LABEL io.task-handoff.image.capabilities=terminal,gui-terminal,browser,web-cap,codex,claude

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-entrypoint"]
CMD ["task-handoff", "web"]

FROM profile-browser-root AS profile-browser
ARG TASK_HANDOFF_BUILD_ID=local
ARG TASK_HANDOFF_BUILT_AT=unknown
ARG TASK_HANDOFF_GIT_COMMIT=
ARG TASK_HANDOFF_IMAGE_REF=task-handoff-controlled-browser:local
ARG TASK_HANDOFF_IMAGE_DIGEST=
ENV TASK_HANDOFF_IMAGE_PROFILE=browser
ENV TASK_HANDOFF_IMAGE_CAPABILITIES=terminal,gui-terminal,browser,vscode-web,codex,claude
ENV TASK_HANDOFF_BUILD_ID=${TASK_HANDOFF_BUILD_ID}
ENV TASK_HANDOFF_BUILT_AT=${TASK_HANDOFF_BUILT_AT}
ENV TASK_HANDOFF_GIT_COMMIT=${TASK_HANDOFF_GIT_COMMIT}
ENV TASK_HANDOFF_IMAGE_REF=${TASK_HANDOFF_IMAGE_REF}
ENV TASK_HANDOFF_IMAGE_DIGEST=${TASK_HANDOFF_IMAGE_DIGEST}
LABEL io.task-handoff.image.profile=browser
LABEL io.task-handoff.image.capabilities=terminal,gui-terminal,browser,vscode-web,codex,claude

USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["task-handoff-healthcheck"]
ENTRYPOINT ["tini", "--", "task-handoff-entrypoint"]
CMD ["task-handoff", "web"]
