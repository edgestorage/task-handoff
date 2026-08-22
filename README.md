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
- **Environment templates** — Save a Docker instance's installed tools and container configuration as a node-local reusable environment, then combine it with any project or local-folder workspace.
- **AI session center** — View and control sessions across instances with real-time state delivered over WebSocket.
- **Repository workflows** — Inspect files, changes, branches, and worktrees, with conservative remote delivery for Git repositories.
- **Chat integrations** — Route messages, approvals, and actions from Telegram, DingTalk, WeChat, and Feishu/Lark to a selected instance.
- **Application management** — Install, remove, and run applications on target instances through a trusted built-in catalog.
- **Mobile client** — Connect an iOS or Android device directly to a user-managed Control Plane for AI sessions, instance operations, applications, and terminals.
- **Desktop and server deployment** — Run TaskHandoff as a mobile or desktop application, or as systemd services on Debian and Ubuntu.
- **English and Chinese UI** — Switch languages instantly or follow the browser language automatically.

## Architecture

```text
Browser / Desktop / Mobile / Chat platforms
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

TaskHandoff is organized into three runtime layers:

- **Control Plane** provides the Web/API management surface and owns the node inventory, instance board, chat gateway, and cross-instance AI session views.
- **Node Agent** runs on each managed machine and owns node-local configuration, runtime resources, folder inventory, and controlled instance lifecycles. Instances continue running when the control plane is stopped or restarted.
- **Controlled Instance** hosts a workspace, applications, AI sessions, triggers, and metadata. It can run standalone; in a managed deployment, its lifecycle and access are owned by the Node Agent.

Chat and AI Session state form a cross-layer path: the Control Plane owns chat credentials, bindings, command parsing, and routing, while each target AI Session remains the source of truth for conversation state.

Docker is the primary isolated runtime and supports multiple instances on one node. A built-in Local Runtime is also available on supported non-Windows nodes for one controlled instance per host user. Runtime capabilities and adapters keep the same model extensible to Kubernetes without creating a separate UI flow.

### Environment templates

An environment template is a node-local Docker image created from an existing instance with `docker commit`. Registry images and environment templates are peer environment sources in the instance creation flow. Workspace selection remains independent, so either source can be combined with a Git project or a local-folder workspace.

Templates capture only the container writable layer, such as installed system packages and tools. They exclude `/workspace`, `/data`, `/home/agent`, every other bind mount or volume, memory, processes, and network state. Derived instances always receive a new identity, registration token, port, and managed volumes. The node agent briefly pauses the source container during commit and rejects a template if Docker Config contains instance-private credentials.

Every Docker instance has managed volumes for `/data` and `/home/agent`; Git workspaces also have a managed `/workspace` volume, while local folders use an external bind mount. The instance deletion dialog uses one option, selected by default, to delete all managed data. Clearing it retains every managed volume and reports its name; retained volumes are never attached automatically to another instance.

The source node owns both the template record and its Docker image, so a template can be used only on that node while it is ready. Deleting a template removes its internal template tag. A content-addressed internal lease keeps the image recoverable while derived instances reference it, and the image is garbage-collected after the final reference is removed.

## Quick Start

### Requirements

- Node.js `>= 24.15.0 < 25`
- pnpm `9.15.3`
- Docker, when using Docker Runtime, building container images, or running the standalone Compose profile

### Local development

```sh
pnpm install
pnpm run build:all
pnpm cli help
```

Start the Control Plane API and development UI in separate terminals. The disabled authentication mode is intended only for loopback development:

```sh
pnpm cli control-plane --auth-mode disabled
pnpm run control-plane-ui:dev
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

To run a standalone Browser-profile controlled instance instead of the Control Plane development stack:

```sh
docker compose up -d --build
```

The current directory is mounted at `/workspace` by default. Set `TASK_HANDOFF_WORKSPACE_HOST` to mount a different host directory. This Compose service is a standalone controlled instance, not a Control Plane and Node Agent deployment.

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

Remote machines only need the Node Agent. Generate a one-time join token in the Control Plane and prefer the exact installation command shown there. Its package version is resolved from the running Control Plane release. The equivalent form is:

```sh
curl -fsSL https://CONTROL_PLANE_HOST/install-node-agent.sh | sudo sh -s -- \
  --control-plane https://CONTROL_PLANE_HOST \
  --join-token JOIN_TOKEN \
  --npm-package @task-handoff/node-agent \
  --controlled-instance-package @task-handoff/controlled-instance \
  --version RELEASE_VERSION
```

On Debian and Ubuntu, the remote-node installer bootstraps the required Node.js
24, npm, and native build tools on a fresh host.

Replace `RELEASE_VERSION` with the Control Plane's runtime package version so the Node Agent and controlled-instance runtime use the same release.

An installed Node Agent can also generate a one-time invitation directly on the node:

```sh
sudo task-handoff-node-agent invite --ipc-path /run/task-handoff/node-agent.sock
```

Add `--json` for automation-friendly output. Remote TCP access still requires an invitation and paired HMAC authentication.

To remove a standalone Node Agent installation:

```sh
sudo task-handoff-node-agent uninstall
```

The command removes the systemd service and runtime packages, then asks whether to delete the Node Agent data directory. The default is No. Use `--keep-data` or `--delete-data` for non-interactive execution. Managed Docker volumes are preserved.

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
apps/mobile/                      Expo iOS and Android client
packages/control-plane/           Control plane, Node Agent, and chat gateway
packages/control-plane-client/    Shared Control Plane API and realtime client
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

### Runtime and server packages

A semantic version tag such as `v1.2.3` builds the controlled-instance runtime artifacts, publishes `@task-handoff/control-plane`, `@task-handoff/node-agent`, `@task-handoff/controlled-instance`, and `@task-handoff/server`, and attaches the installer and immutable artifacts to the GitHub Release. `alpha` and `beta` versions use their matching npm dist-tags; stable versions update `latest`.

### Docker images

The Docker workflow builds and smoke-tests four image profiles:

| Image | Profile capabilities |
| --- | --- |
| `task-handoff-controlled-codex` | Terminal and Codex |
| `task-handoff-controlled-ai` | Terminal, Codex, and Claude |
| `task-handoff-controlled-webcap` | GUI terminal, browser, WebCap, Codex, and Claude |
| `task-handoff-controlled-browser` | GUI terminal, browser, VS Code Web, Codex, and Claude; no WebCap |

All four receive the same immutable `sha-<commit>` tag. A semantic version tag such as `v1.2.3` promotes the corresponding images to that version; stable releases also update `latest`.

### Desktop application

Semantic version tags build macOS arm64/x64, Windows x64, and Linux x64 installers and publish them to GitHub Releases. Versions with an `alpha` or `beta` suffix are marked as prereleases. macOS artifacts are signed, notarized, stapled, and verified with Gatekeeper. Windows code signing is not enabled yet.

Closing the Desktop control-panel window keeps TaskHandoff running in the system tray. The tray shows the current Control Plane and Node Agent service status and can reopen the existing window without restarting either service. Choose **Quit TaskHandoff** from the tray or the platform application menu to stop the Desktop services. A graceful Node Agent shutdown stops Local Runtime controlled instances so they can be restored on the next launch; Docker Runtime controlled instances keep running and are rediscovered when the Node Agent returns.

### Mobile application

A stable tag in the exact form `mobile-vX.Y.Z` runs the mobile release checks and starts independent Android and iOS release jobs. Android produces an APK and attaches it to the corresponding GitHub Release. After approval through the `ios-production` environment, iOS builds are submitted to App Store Connect/TestFlight; final App Store review remains a manual action. Android is not submitted to Google Play by this workflow.

See [`apps/mobile/README.md`](apps/mobile/README.md) for the client boundary and development commands, and [`apps/mobile/RELEASE.md`](apps/mobile/RELEASE.md) for credentials, first-build setup, and release operations.

## License

TaskHandoff is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.
