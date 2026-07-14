# Codex Control Plane

This repo is evolving from a standalone task handoff CLI into a control plane
for running and supervising Codex work across local and remote workspaces. The
product is organized around four cooperating layers:

- **Control plane**: the web/API management surface. It owns the operator UI,
  node inventory, instance board, chat gateway, and cross-instance AI session
  views.
- **Node agent**: the machine-local runtime manager. It owns node-local
  configuration, runtime resources, controlled instance lifecycle, local folder
  inventory, and host-side session launching.
- **Controlled instance**: a managed workspace runtime, usually Docker today,
  with its own controlled instance API, app runtime, AI sessions, triggers, and metadata.
  The agent is responsible for starting, restoring, stopping, and proxying it.
- **Chat gateway and AI sessions**: the control plane owns Telegram, DingDing,
  Wechat, bindings, and approval routes. AI sessions in each controlled instance
  are the source of truth for conversation state and controls.

Chat integrations such as Telegram, DingDing, Wechat, and future bridges route
through the control-plane gateway to the selected instance's AI-session API.
Controlled instances do not store chat credentials, channels, receiver
conversations, or receiver pending tasks. The standalone `task-handoff receiver`
CLI remains available as an independent legacy workflow.

## Runtime Model

The control plane talks to node agents; node agents manage runtime-specific
resources and expose controlled instances back to the control plane. Docker is
the current primary runtime, with the model structured so Kubernetes and local
host runtimes can be added through runtime capabilities/adapters rather than
special-case UI flows.

For local Docker testing on this machine, use:

```sh
scripts/docker-up-workspace-local.sh
```

That local helper sets `TASK_HANDOFF_WORKSPACE_HOST=/Users/example/project/work`
before running `pnpm run docker:up:all`, so the container sees that host
directory as `/workspace`. Keep this script local/ignored and do not change the
default `compose.yml` workspace mount for this machine path.

## Server Web Install

Server deployments run the control plane and the server-local node-agent as
separate sibling services. The local node-agent is expected to be up alongside
the web control plane, but it is not a child process of the control plane.

The co-located control plane always manages that local node-agent through its
private Unix socket. In **Settings → Nodes**, the built-in local node can
separately configure the node-agent TCP port and choose loopback-only or all
IPv4 interfaces so other control-planes can pair with it. The socket itself is
always retained and is not a UI setting; remote TCP access continues to require
an invite and paired-HMAC authentication.

On a fresh Debian or Ubuntu server, the bootstrap installer installs Node.js,
Docker, the complete `@task-handoff/server` package, and both systemd services:

```sh
curl -fsSL INSTALL_SERVER_SCRIPT_URL | sudo sh
```

Release distributions should replace `INSTALL_SERVER_SCRIPT_URL` with the URL
of `scripts/install-server.sh` from the same release. See
[docs/server-install.md](docs/server-install.md) for local-tarball installs and
all supported options.

If Node.js and Docker are already installed, install the global server package.
It pins and installs the control-plane, node-agent, and controlled-instance
runtimes at the same version:

```sh
sudo npm install -g @task-handoff/server@latest
sudo task-handoff install
```

Check for and apply npm-based server updates:

```sh
task-handoff check
sudo task-handoff update
```

The aggregate server package also provides `task-handoff control-plane`,
`task-handoff node-agent`, and `task-handoff controlled-instance` as aliases.
The three runtime packages retain their independent executables for standalone
installation.

The aggregate server package can manage both installed systemd services with
`sudo task-handoff start`, `sudo task-handoff stop`, and
`sudo task-handoff restart`. It preserves the node-agent/control-plane startup
and shutdown ordering.

Both commands default to the installed server's release channel: an alpha
install checks `alpha`, a beta install checks `beta`, and a stable install
checks `stable`, which resolves to npm's standard `latest` dist-tag. Use
`--channel` to switch channels explicitly.

This npm updater is only for server runtimes and systemd services. Desktop
application updates use the separate signed desktop release channel.

The control plane provides the fleet update entry under each node's **Updates**
tab. It checks and triggers node-agent and controlled-instance updates through
that node-agent, defaults every operation to `stable`, and records update jobs
on the node. Docker instances follow the selected registry channel and preserve
their per-instance data and agent-home volumes when recreated. Desktop updates
remain separate.

The aggregate server update is exposed at **Settings → Basic → Server updates**,
with stable, beta, and alpha channel selection. Theme and public URL settings
also live in Basic; Desktop keeps its independent application updater.

That creates:

```txt
task-handoff-node-agent.service
task-handoff-control-plane.service
```

Remote nodes install only the node-agent. The control plane serves a generic
installer at `/install-node-agent.sh`; pass a one-time join token generated by
the control plane:

```sh
curl -fsSL https://CONTROL_PLANE_HOST/install-node-agent.sh | sudo sh -s -- \
  --control-plane https://CONTROL_PLANE_HOST \
  --join-token JOIN_TOKEN \
  --npm-package @task-handoff/node-agent \
  --controlled-instance-package @task-handoff/controlled-instance \
  --version 1.0.0
```

See [docs/server-install.md](docs/server-install.md) for install options and
the upgrade flow.

## CLI and Receiver Usage

The original task-handoff CLI is still the command-line and receiver layer:

- sender: `send` command, sends a `result` value and waits for a reply
- mcp: stdio MCP server exposing the sender as one tool
- receiver: Ink-powered TUI, receives results and replies from terminal or chat
  bridges

Start the receiver:

```sh
pnpm cli receiver
```

Send a result:

```sh
pnpm cli send --result "# Build finished"
pnpm cli send -c 2 --result "# Build finished for conversation 2"
pnpm cli send --result "See attachments" --image ./shot.png --file ./report.pdf
```

Run the sender as an MCP server:

```sh
pnpm cli mcp
```

Install the MCP server into your user Codex or Claude Code config:

```sh
task-handoff install mcp all
task-handoff status mcp all
task-handoff uninstall mcp codex
```

The MCP server exposes one tool named `get_task`. Its arguments are
`conversationId` and `result`; calling it sends the result to the receiver and
returns the receiver reply as text. The tool also accepts `imagePaths` and
`filePaths` arrays. Attachment paths are shown as buttons at the end of the
chat message; the actual file or image is uploaded only after a user clicks the
button. Timeout target replies for MCP-originated
tasks tell the caller to continue by sending `ready` with the MCP tool instead
of the CLI command.

The Codex installer writes a managed `mcp_servers.task_handoff` entry to
`~/.codex/config.toml`. The Claude installer writes a managed
`mcpServers.task_handoff` entry to `~/.claude/settings.json`. Both installers
back up the target config before changing it and preserve unrelated MCP servers.
Use `task-handoff uninstall mcp codex` or `task-handoff uninstall mcp claude`
to remove the managed server entry. The `all` target automatically installs
only the detected Codex or Claude Code user configs. Use `--codex-home <path>`
or `--claude-home <path>` to target a different settings directory, or
`--name <value>` to manage a different MCP server name.

`result` supports Markdown. The receiver keeps the original Markdown text, and
Telegram delivery renders it as Telegram Markdown. Type one line in the receiver
input, or reply in Telegram, and the sender prints that reply to stdio.
Use `--image <path...>` and `--file <path...>` to attach local files. Telegram
renders one inline button per attachment and sends the selected image or file
only after the button is clicked. Other chat bridges show the attachment list
and may fall back when direct upload is not supported.
Passive conversations are selected with `-c, --conversation <id>`. Passive mode
does not need a working directory; the id is only used to route results and
replies to the matching terminal, Telegram, or Wechat channel.
The receiver keeps conversations in `~/.config/task-handoff/config.json`.
`/c new` creates and switches to a new passive conversation, `/c use <id>`
switches terminal replies, and `/conversation close <id>` marks a conversation
closed without deleting its saved record. `/conversation delete <id>` removes a
conversation and its saved bindings when there are no pending or queued items.
Non-default conversations with no MCP, sender, or permission-request activity
for 12 hours are cleaned up automatically under the same pending/queued guard.
The terminal reply input supports real multiline Markdown: press Enter to send
and Ctrl+Enter to insert a newline.

Receiver commands use `/`:

```txt
/help                         Show receiver commands
/status                       Show pending senders and settings
/c new                        Create and switch to a passive conversation
/c list                       List conversations
/c use <id>                   Switch terminal replies to a conversation
/conversation use <id>        Set the terminal reply conversation
/conversation new             Create and switch to a passive conversation
/conversation list            List conversations
/conversation default <id>    Set default conversation for senders
/conversation close <id>      Close a conversation without deleting it
/conversation delete <id>     Delete a conversation and its bindings
/conversation open <id>       Reopen a closed conversation
/conversation status          Show conversation routing
/list                         List pending tasks
/chat status                  Show configured chat tool instance counts
/focus #id                    Set default reply target
/focus clear                  Clear default reply target
/drop #id                     Drop a task by replying continue
/approve #id                  Approve a permission request
/deny #id                     Deny a permission request
/auto-approve on              Auto-approve current conversation
/auto-approve off             Disable auto-approve for current conversation
/timeout <duration>           Set receiver default timeout for new tasks
/timeout reset                Reset receiver default timeout to 1 hour
/telegram status              Show Telegram binding status
/telegram bind <token> [chat] Bind a Telegram bot and optional chat
/telegram chat <chat-id>      Set the Telegram target chat
/telegram conversation <id>   Route Telegram through a conversation
/telegram on                  Enable Telegram polling
/telegram off                 Disable Telegram polling
/telegram unbind              Remove Telegram token and chat
/wechat status                Show Wechat iLink status
/wechat login                 Login Wechat by QR code
/wechat bind <token>          Bind an existing Wechat iLink bot token
/wechat chat <chat-id>        Set the Wechat target chat id
/wechat conversation <id>     Route Wechat through a conversation
/wechat context <token>       Set the Wechat context token
/wechat on                    Enable Wechat long polling
/wechat off                   Disable Wechat long polling
/wechat unbind                Remove Wechat binding
/target <markdown>            Auto-reply near the effective task timeout
/target clear                 Disable timeout auto-reply
/reply <markdown>             Reply to focus, oldest sender, or queue it
/reply #id <markdown>         Reply to a specific pending sender
/quit                         Stop the receiver
plain text                    Reply to focus, oldest sender, or queue it
```

In the receiver TUI, typing `/` opens a command palette. Keep typing to filter,
use Up/Down to move through all matches, then press Tab or Enter to complete the
highlighted command.

Chat integrations use the same receiver input rules: messages that start with
`/` run receiver commands, and other text is treated as a reply for that chat's
bound conversation. This applies to Telegram and Wechat, and new chat bridges
should register with the receiver chat bridge registry and route incoming text
through the shared command-aware chat router. Receiver task, result, and
approval messages are built as platform-neutral chat payloads first; each bridge
then renders that payload with its own platform capabilities. Bridges declare
capabilities such as buttons, Markdown, reactions, editable messages, and
progress updates so delivery and progress handling can degrade gracefully.

You can bind Telegram when starting the receiver:

```sh
pnpm cli receiver \
  --telegram-token "123456:BOT_TOKEN" \
  --telegram-chat-id "123456789" \
  --telegram-allowed-user-ids "111111,222222"
```

When Telegram is bound, incoming results for Telegram's conversation are sent to
that chat. A text message sent back to the bot is treated like receiver input
for that same conversation and is returned to the focused waiting sender in that
conversation, or the oldest waiting sender there when no focus is set. If no
sender is currently waiting in that conversation, a plain text reply is queued
and automatically sent to the next sender that connects with the same
conversation id. Set `--telegram-allowed-user-ids` or the saved config to
restrict which Telegram users can send messages or press inline buttons. If no
allowlist is configured, the first Telegram user who sends a message is bound
automatically and later users are ignored.
Telegram bindings created with `/telegram bind`, `/telegram chat`, or automatic
chat binding are saved to `~/.config/task-handoff/config.json` by default. Set
`TASK_HANDOFF_CONFIG=/path/to/config.json` to use a different config file.
Use `/telegram conversation <id>` or `--telegram-conversation <id>` to bind
Telegram to a passive conversation.

Wechat uses Tencent iLink/OpenClaw-style long polling. Start with:

```txt
/wechat login
```

Scan the QR code, then send any message to the Wechat bot so the receiver can
bind the chat id and context token. The CLI renders the returned
`qrcode_img_content` scan URL and keeps the separate `qrcode` ticket for status
polling. After binding, incoming task results are sent to Wechat and text
replies from Wechat are returned within Wechat's bound conversation. Replies
received while no sender is waiting use the same per-conversation queue and are
delivered to the next sender for that conversation.
Use `/wechat conversation <id>` or `--wechat-conversation <id>` to bind Wechat
to a passive conversation.

If you do not know the chat id yet, bind only the bot token:

```txt
/wechat bind bot_token
```

Then send any message to the bot in Wechat. The receiver will bind that chat id
and context token automatically. The first message is used for binding; later
text messages are used as replies.
Wechat login/binding state is also saved to the same config file, including
`token`, `baseUrl`, `chatId`, `contextToken`, and `updatesBuf`, so receiver
restarts can resume polling and replies without re-entering every value.

DingDing can restrict controlling users the same way Telegram does. Pass
`--dingding-allowed-user-ids "111111,222222"` when starting the receiver. If no
allowlist is configured, the first DingDing user who sends a message or presses a
card button is bound automatically and later users are ignored.

Show detailed help:

```sh
pnpm cli help
```

Print the reply exactly as received, without Markdown rendering:

```sh
pnpm cli --raw --result "build finished"
```

By default, task timeout is receiver-controlled. New tasks use the receiver's
current `/timeout` value, and MCP-originated calls are additionally bounded by
the MCP host tool timeout. The sender does not send a timeout override unless
you pass `--timeout`.

The sender can explicitly override the task timeout:

```sh
pnpm cli --timeout 10m --result "build finished"
pnpm cli --timeout 30s --result "quick check"
```

If the receiver is not running yet and no sender timeout override was provided,
the sender waits and retries connecting. For Codex MCP installs, the host tool
timeout is configured to 24 hours. If you pass `--timeout`, connection retries
also stop when that timeout expires.

The receiver can also set its default timeout for new incoming tasks:

```txt
/timeout 10m
/timeout 30s
/timeout reset
```

Sender `--timeout` wins for that task. If the sender does not pass `--timeout`,
the receiver uses its current `/timeout` value for display, timeout-target
automation, and the task's effective timeout.

If the receiver has a timeout target set with `/target <markdown>`, it replies
shortly before the effective task timeout using this template:

```txt
当前目标：「<target>」

如果已完成当前目标，请返回ready，并继续执行命令行以等待新任务或者目标
```

If no target is set, the task remains pending until a receiver, Telegram, or
Wechat reply is sent, or until an explicit sender/MCP host timeout interrupts
the wait.

## Package Bin

The package exposes `task-handoff` as the primary binary and keeps `result-ipc`
as a compatibility alias:

```json
{
  "bin": {
    "task-handoff": "bin/task-handoff.js",
    "result-ipc": "bin/result-ipc.js"
  }
}
```

During development, use:

```sh
pnpm cli help
pnpm cli receiver
pnpm cli send --result "build finished"
```

After global install or package linking, use:

```sh
task-handoff help
task-handoff receiver
task-handoff install mcp all
task-handoff install hook all
task-handoff send --result "build finished"
```

For MCP and hook setup, the unified command shape is
`task-handoff install|status|uninstall <mcp|hook> <codex|claude|all>`. The
`all` target detects existing Codex and Claude Code home directories and skips
tools that are not present.

The legacy alias still works:

```sh
result-ipc help
```

## Claude Code Approval Hook

Claude Code `PermissionRequest` hooks can use the same approval bridge as Codex.
Install the managed user hook with:

```sh
task-handoff install hook claude
task-handoff status hook claude
```

The installer writes a managed `PermissionRequest` entry to
`~/.claude/settings.json`, backs up the settings file before changing it, and
preserves unrelated hooks. Use `task-handoff uninstall hook claude` to remove
the managed hook. The installed command runs
`task-handoff claude-approval-hook`, which forwards permission requests through
the receiver, Telegram, or Wechat and returns Claude Code's allow/deny decision
format. Claude Code gives the managed hook a 24-hour timeout, and the bridge
waits up to 12 hours for a remote approval. If that bridge timeout expires, it
denies the permission request by default.

Use `--claude-home <path>` to target a different Claude settings directory, or
`--command <value>` to install a custom hook command.

## Codex Approval Hook

This repo includes a project Codex hook in `.codex/hooks.json` for
`PermissionRequest` events. When Codex asks for elevated permissions, the hook
runs `task-handoff codex-approval-hook`, forwards the approval request through
the normal sender path, and waits for a reply from the receiver, Telegram, or
Wechat.

To install the hook into your user Codex config, run:

```sh
task-handoff install hook codex
task-handoff status hook codex
```

The installer enables `[features].hooks = true` in `~/.codex/config.toml`,
merges a managed `PermissionRequest` entry into `~/.codex/hooks.json`, backs up
files before changing them, and preserves unrelated hooks. Use
`task-handoff uninstall hook codex` to remove only task-handoff managed entries.
The managed Codex hook has a 24-hour timeout.

In the receiver TUI, approve permission requests with `/approve #id`, skip the
task-handoff decision with `/skip #id`, and reject them with `/deny #id`.
Use `/auto-approve on` to automatically allow future permission requests routed
to the current conversation, `/auto-approve off` to disable it, and
`/auto-approve status` to inspect it. Pass a conversation id as the last
argument to target a specific conversation, for example
`/auto-approve on <conversation-id>`.
Telegram permission requests use inline Allow/Skip/Deny buttons so ordinary
queued replies cannot accidentally approve or deny them. Wechat still accepts
text replies: send `allow`, `approve`, `yes`, or `允许` to approve; `skip` or
`跳过` to leave the decision empty so Codex can fall back to its normal approval
UI; and `deny`, `no`, or `拒绝` to reject. Any other reply also leaves the
decision empty.

The hook sends a compact message containing the event type, tool name,
thread id, turn id, transcript path, permissions, cwd, command, and
justification when those fields are present in the Codex hook input. Each normal
sender call records its conversation against known Codex, Claude Code, and
terminal session identifiers. Permission requests resolve through those recorded
session bindings: Codex `session_id`/`thread_id`, Claude session ids, and
terminal session ids. Explicit `conversationId` fields in the hook payload are
the only manual routing hint. If no session or explicit conversation matches,
the hook skips the task-handoff decision so Codex or Claude can use its normal
approval flow.
It uses `TASK_HANDOFF_APPROVAL_TIMEOUT` when set; otherwise it waits up to 12
hours. If that bridge timeout expires, the hook returns a deny decision.

The hook writes JSONL diagnostics to stderr and to `codex-approval-hook.log`.
Sender calls also write JSONL diagnostics to `sender.log`. In a Codex sandbox,
the default log directory is the current workspace `.task-handoff/` directory so
the process can write without approval; outside the sandbox, logs default beside
the task-handoff config file. These entries
include pid, ppid, cwd, argv, parent process details, and relevant
`TASK_HANDOFF_*`, `CODEX_*`, and `CLAUDE_*` environment variables with
secret-looking values redacted. Set `TASK_HANDOFF_APPROVAL_LOG` or
`TASK_HANDOFF_SENDER_LOG` to override the log paths.

Codex may ask you to trust new or changed project hooks the next time this repo
is opened.

Before publishing, check the package contents:

```sh
pnpm run pack:dry
```

### Docker releases

Every push to `main` builds and smoke-tests the controlled-instance image, then
publishes it to Docker Hub under the immutable `sha-<commit>` tag. Pushing a
semantic version tag such as `v1.2.3` does not rebuild the image: the Docker
workflow waits for that commit image and promotes it to `v1.2.3` in the
registry. Stable releases also update `latest`; prerelease tags such as
`v1.2.3-rc.1` do not.

Publishing requires the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository
secrets. `DOCKERHUB_IMAGE_NAME` can optionally override the default
`task-handoff-controlled-instance` repository name.

### Desktop releases

With Node.js 22.22.2 or newer, pushing a semantic version tag such as `v1.2.3`
builds signed and notarized macOS arm64/x64 installers plus unsigned Windows
x64 and Linux x64 installers, then attaches them to a GitHub Release. Tags with
a prerelease suffix, such as `v1.2.3-rc.1`, create a GitHub prerelease.
The workflow can also be run manually to validate installers without publishing
a release. Both macOS jobs require these GitHub Actions repository secrets:

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate
- `MAC_CSC_KEY_PASSWORD`: password used when exporting the `.p12` certificate
- `APPLE_API_KEY_P8`: base64-encoded App Store Connect API key `.p8` file
- `APPLE_API_KEY_ID`: App Store Connect API key ID
- `APPLE_API_ISSUER`: App Store Connect API issuer UUID

The workflow rejects missing credentials, signs with hardened runtime, submits
the app to Apple's notary service, staples the resulting ticket, and verifies
the signature, ticket, and Gatekeeper assessment before uploading artifacts.
Windows code signing is not enabled yet.

## Package Map

The codebase is split by responsibility:

```txt
bin/task-handoff.js                    Runtime shim that loads dist/cli.js
bin/result-ipc.js                      Backward-compatible binary alias
apps/cli/src/index.ts                  Commander entrypoint
apps/cli/src/hooks/                    Codex, Claude, and MCP installer hooks
apps/cli/src/mcp/index.ts              Stdio MCP server exposing get_task
packages/core/src/core/                Defaults, protocol, socket, persistence
packages/core/src/storage/             Local storage repositories
packages/protocol/src/sender.ts        One-shot sender client
packages/receiver-worker/src/app.ts    Ink TUI, receiver queue, commands
packages/receiver-worker/src/receiver-entry.ts Dynamic receiver bridge
packages/receiver-worker/src/integrations/ Telegram, DingDing, Wechat bridges
packages/controlled-instance/src/web/  Controlled instance HTTP/WebSocket API
packages/app-runtime/src/              Desktop app runtime manager
packages/controlled-instance-ui/src/   Controlled instance Vue web UI
packages/control-plane-ui/src/         Control plane Vue web UI
packages/terminal-ui/src/index.ts      Terminal colors, boxes, Markdown rendering
packages/web-theme/index.css           Shared web theme public entry
dist/                                  Rollup-built JavaScript used by the CLI
```

New integrations should live in `packages/receiver-worker/src/integrations/` and talk to the
receiver through callbacks, instead of being mixed into the CLI entrypoint.

The receiver UI is built with Ink. It shows a status panel, pending senders, the
latest result, event logs, and a command input at the bottom.
