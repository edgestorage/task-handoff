<div align="center">
  <img src="build/icon.png" alt="TaskHandoff Logo" width="144" height="144">
  <h1>TaskHandoff</h1>
  <p><strong>A unified control plane for running, managing, and collaborating with AI workspaces across local and remote machines</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24">
    <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3">
    <img src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white" alt="TypeScript 6">
    <img src="https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white" alt="Docker Ready">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-D22128" alt="Apache-2.0 License"></a>
  </p>
  <p><strong>English</strong> | <a href="README_CN.md">简体中文</a></p>
</div>

---

TaskHandoff brings Codex and other AI development work into one control plane. It connects AI sessions spread across machines, workspaces, and chat platforms while managing node enrollment, instance lifecycles, sessions, applications, and message routing.

> TaskHandoff is evolving from a standalone task handoff CLI into a complete AI workspace control plane. Some capabilities and interfaces are still changing.

## Features

- **Multi-node management** — Connect local and remote nodes and inspect their resources and managed instances from one place.
- **Managed workspaces** — Create, start, stop, and restore isolated workspaces, with Docker as the primary runtime today.
- **Image market and custom images** — Choose from a read-only built-in catalog or separately managed custom images through one instance creation flow.
- **AI session center** — View and control sessions across instances with real-time state delivered over WebSocket.
- **Repository workflows** — Inspect files, changes, branches, and worktrees, with conservative remote delivery for Git repositories.
- **Chat integrations** — Route messages, approvals, and actions from Telegram, DingTalk, WeChat, and future adapters to a selected instance.
- **Application management** — Install, remove, and run applications on target instances through a trusted built-in catalog.
- **Desktop and server deployment** — Run TaskHandoff as a desktop application or as systemd services on Debian and Ubuntu.
- **English and Chinese UI** — Switch languages instantly or follow the browser language automatically.

## Architecture

```text
Browser / Desktop / Chat platforms
                 │
                 ▼
          Control Plane
       UI, API, and chat gateway
                 │
                 ▼
            Node Agent
   Node resources and instance lifecycle
                 │
                 ▼
       Controlled Instance
 Workspace, applications, and AI sessions
```

TaskHandoff is organized into four cooperating layers:

- **Control Plane** provides the Web/API management surface and owns the node inventory, instance board, chat gateway, and cross-instance AI session views.
- **Node Agent** runs on each managed machine and owns node-local configuration, runtime resources, folder inventory, and controlled instance lifecycles. Instances continue running when the control plane is stopped or restarted.
- **Controlled Instance** hosts a workspace, applications, AI sessions, triggers, and metadata. It typically runs in Docker and is accessed through the Node Agent.
- **Chat Gateway and AI Sessions** keep chat credentials, bindings, command parsing, and routing in the control plane, while each target AI Session remains the source of truth for conversation state.

Docker is the primary runtime today. Runtime capabilities and adapters keep the model open to Kubernetes and local-host runtimes without creating separate UI flows for each environment.

## Quick Start

### Requirements

- Node.js `>= 24.15.0 < 25`
- pnpm `9.15.3`
- Docker, when running the complete local stack or controlled instances

### Local development

```sh
pnpm install
pnpm run build:all
pnpm cli help
```

Common development commands:

```sh
# Start the control-plane UI
pnpm run control-plane-ui:dev

# Type-check and build
pnpm run typecheck
pnpm run web:typecheck
pnpm run build:all

# Run tests
pnpm test

# Inspect the npm package contents
pnpm run pack:dry
```

Start the complete Docker environment:

```sh
pnpm run docker:up:all
```

The current directory is mounted at `/workspace` by default. Set `TASK_HANDOFF_WORKSPACE_HOST` to mount a different host directory:

```sh
TASK_HANDOFF_WORKSPACE_HOST=/path/to/workspace pnpm run docker:up:all
```

## Server Deployment

Server deployments install the Control Plane and the server-local Node Agent as independent systemd services. The control plane can stop or restart without terminating instances managed by the agent.

### One-line installation

On a Debian or Ubuntu server running systemd, run the latest stable installer as root:

```sh
curl -fsSL https://github.com/edgestorage/task-handoff/releases/latest/download/install-server.sh | sudo sh
```

The script checks the host, installs Node.js 24 and Docker when needed, installs the latest stable `@task-handoff/server` package from npm, and then creates and starts the Control Plane and Node Agent systemd services. By default, the control plane listens on port `8081` with password authentication enabled. Installer options can change the port, authentication mode, release channel, and other service settings.

### Install with Node.js and Docker already available

```sh
sudo npm install -g @task-handoff/server@latest
sudo task-handoff install
```

Manage services and updates:

```sh
sudo task-handoff start
sudo task-handoff stop
sudo task-handoff restart

task-handoff check
sudo task-handoff update
```

The installation creates:

```text
task-handoff-node-agent.service
task-handoff-control-plane.service
```

See [`scripts/install-server.sh`](scripts/install-server.sh) for supported installer options.

## Connect a Remote Node

Remote machines only need the Node Agent. Generate a one-time join token in the control plane, then run this on the target node:

```sh
curl -fsSL https://CONTROL_PLANE_HOST/install-node-agent.sh | sudo sh -s -- \
  --control-plane https://CONTROL_PLANE_HOST \
  --join-token JOIN_TOKEN \
  --npm-package @task-handoff/node-agent \
  --controlled-instance-package @task-handoff/controlled-instance \
  --version 1.0.0
```

An installed Node Agent can also generate a one-time invitation directly on the node:

```sh
sudo task-handoff-node-agent invite --ipc-path /run/task-handoff/node-agent.sock
```

Add `--json` for automation-friendly output. Remote TCP access still requires an invitation and paired HMAC authentication.

## CLI

`@task-handoff/server` provides the unified `task-handoff` command:

```sh
task-handoff control-plane
task-handoff node-agent
task-handoff node-agent-invite
task-handoff web
task-handoff help
```

Use `pnpm cli help` during development. Chat adapters, bindings, AI session messages, queues, and approvals are managed by the control plane.

## Interface Language

The control-plane UI supports English (`en-US`) and Simplified Chinese (`zh-CN`). Open **Settings → Appearance → Language** to follow the system language or choose a language explicitly. The interface updates without reloading control-plane data.

The preference is stored only in the current browser. Terminal output, logs, AI messages, repository content, and other user- or provider-supplied data are never translated.

## Repository Layout

```text
apps/cli/                         CLI entry point
apps/desktop-shell/               Electron desktop shell
packages/control-plane/           Control plane, Node Agent, and chat gateway
packages/control-plane-ui/        Control-plane Vue UI
packages/controlled-instance/     Controlled-instance HTTP/WebSocket API
packages/controlled-instance-ui/  Frozen controlled-instance Vue UI
packages/ai-session-runtime/      AI session runtime
packages/app-runtime/             Managed application runtime and catalog
packages/protocol/                Cross-component protocols and data models
packages/core/                    Shared capabilities, diagnostics, and storage
packages/web-theme/               Web theme and Markdown rendering
scripts/                          Installation, build, and runtime scripts
```

## Releases

### Docker images

Every push to `main` builds and smoke-tests three cumulative images:

- `task-handoff-controlled-codex`
- `task-handoff-controlled-ai`
- `task-handoff-controlled-browser`

All three receive the same immutable `sha-<commit>` tag. A semantic version tag such as `v1.2.3` promotes the corresponding images to that version; stable releases also update `latest`.

### Desktop application

Semantic version tags build macOS arm64/x64, Windows x64, and Linux x64 installers and publish them to GitHub Releases. Versions with an `alpha` or `beta` suffix are marked as prereleases. macOS artifacts are signed, notarized, stapled, and verified with Gatekeeper. Windows code signing is not enabled yet.

## License

TaskHandoff is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.
