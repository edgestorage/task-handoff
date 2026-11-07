# Controlled Instance HTTP and WebSocket Route Matrix

This matrix separates the frozen `v0.0.46` compatibility baseline from the target-current Node route surface. Target-current extensions added after `v0.0.46` are tracked separately so they cannot silently expand the compatibility baseline. Both sections are frozen from Node route registrations and are the source checklist for Rust registration and differential tests.

## Authority and scope

- Baseline source: Node `v0.0.46` under `packages/controlled-instance/src`.
- Target-current source: the working tree's `packages/controlled-instance/src/web/server.ts`, `repository/routes.ts`, `web/instance-shell.ts`, and `web/story-agent-tool-bridge.ts`.
- Scope: the controlled-instance runtime only. Control Plane, Node Agent public APIs, desktop clients, and the frozen Vue UI are outside this matrix.
- Static UI fallback (`/` and non-`/api` paths) is part of the runtime but is not an API route.
- `ui/**` remains the frozen web asset exception. No route in this matrix may call a Node business fallback.

## Authentication levels

| Level | Credential | Routes |
| --- | --- | --- |
| Public | None | `/api/health`, `/api/auth/status` |
| Web | Web token from bearer header or `token` query parameter when enabled | Every route not listed as public, node-agent, or agent-tool scoped |
| Node Agent process | `TASK_HANDOFF_REGISTRATION_TOKEN`; most routes are controlled-mode only | `/api/internal/node-agent/*`, `/api/internal/node-agent-connection`, `/api/internal/instance-shell` |
| Node Agent private config | `TASK_HANDOFF_REGISTRATION_TOKEN` | `/api/internal/ai-session-persistence-settings`, `/api/internal/model-environment`, `/api/internal/model-catalog`, `/api/internal/codex-settings` |
| Agent tool | Ephemeral Story tool bridge token | `POST /api/internal/agent-tools/invoke`, `GET/POST/DELETE /api/internal/agent-tools/mcp` |

When web auth is disabled, web routes remain reachable without a token. Node Agent and agent-tool routes still require their own credentials. Authentication failure uses the route-specific structured error code and never falls back to another token domain.

## Response conventions

- JSON success responses use `{ "data": ... }`; failures use `{ "error": { "code": "...", "message": "..." } }`.
- The default successful status is `200`. Explicit exceptions are `201` for attachment draft creation, `202` for instance shutdown and app-management jobs, and `204` for an already-closed AI Session.
- Missing objects use `404`; invalid request models use `400`; authentication failures use `401` or `403`; state conflicts use `409`; unavailable providers use `503` or `409` according to the route's structured code.
- Request bodies are JSON unless the table marks them as binary, multipart/streamed, or proxy pass-through.
- `WebSocket` means a `GET` upgrade with `101`; `HTTP/WS proxy` means `GET` can upgrade while other listed methods remain HTTP; `HTTP proxy` never upgrades.
- WebSocket upgrades require the standard web or Node Agent auth domain shown in the table.

## `v0.0.46` compatibility baseline

This section freezes 201 explicit Node registrations at tag `v0.0.46`, including five WebSocket upgrade registrations. The baseline is authoritative for migration compatibility checks; target-current Node has 206 registrations, with `GET /api/internal/instance-shell` and the four App install-environment routes added after the baseline.

### Route matrix

| Method | Path | Auth | Transport | Success / notes |
| --- | --- | --- | --- | --- |
| `POST` | `/api/ai-session-attachments/draft-streams` | Web | JSON | 201 |
| `DELETE` | `/api/ai-session-attachments/draft-streams/:attachmentId` | Web | JSON | 200 |
| `PUT` | `/api/ai-session-attachments/draft-streams/:attachmentId` | Web | Binary stream | 200 |
| `POST` | `/api/ai-session-attachments/draft-streams/:attachmentId/complete` | Web | JSON | 200 |
| `POST` | `/api/ai-session-attachments/drafts` | Web | JSON | 201 |
| `DELETE` | `/api/ai-session-attachments/drafts/:attachmentId` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions` | Web | JSON | 200 |
| `DELETE` | `/api/ai-sessions/:id` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/approval` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/close` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/commands` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/fork` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/interrupt` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/mentions` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/mentions/files` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/messages` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/messages/:messageId/attachments/:attachmentId/content` | Web | Binary/text stream | 200 |
| `PUT` | `/api/ai-sessions/:id/model-selection` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/open-app` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/queue` | Web | JSON | 200 |
| `DELETE` | `/api/ai-sessions/:id/queue/:queueId` | Web | JSON | 200 |
| `PATCH` | `/api/ai-sessions/:id/queue/:queueId` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/queue/:queueId/retry` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/queue/:queueId/steer` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/queue/pause` | Web | JSON | 200 |
| `PATCH` | `/api/ai-sessions/:id/queue/reorder` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/read` | Web | JSON | 200 |
| `PUT` | `/api/ai-sessions/:id/reasoning-effort` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/ai-sessions` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/branches` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/branches/checkout` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/branches/create` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/branches/delete` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/branches/tracking` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/changes` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/commits` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/context` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/delivery/fetch` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/delivery/publish` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/delivery/pull` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/delivery/push` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/diff` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/directories` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/discard/all-tracked` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/discard/worktree` | Web | JSON | 200 |
| `DELETE` | `/api/ai-sessions/:id/repository/files` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/files` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/files` | Web | JSON | 200 |
| `PUT` | `/api/ai-sessions/:id/repository/files` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/files/rename` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/files/search` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/index/stage` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/index/unstage` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/remotes` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/repository/worktrees` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/worktrees` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/worktrees/ai-sessions` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/repository/worktrees/remove` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/resume` | Web | JSON | 200 |
| `PUT` | `/api/ai-sessions/:id/story` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/story-content` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/story-content/get` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/story-content/set` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/timeline` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/timeline/sync` | Web | JSON | 200 |
| `PUT` | `/api/ai-sessions/:id/title` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/transcript` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/turns` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/turns/:turnId` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/:id/turns/:turnId/timeline` | Web | JSON | 200 |
| `POST` | `/api/ai-sessions/:id/turns/:turnId/timeline/sync` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/history` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/history/:id` | Web | JSON | 200 |
| `GET` | `/api/ai-sessions/state` | Web | JSON | 200 |
| `POST` | `/api/apps/:appId/install` | Web | JSON | 202 |
| `GET` | `/api/apps/:appId/profiles` | Web | JSON | 200 |
| `POST` | `/api/apps/:appId/profiles` | Web | JSON | 200 |
| `DELETE` | `/api/apps/:appId/profiles/:profileId` | Web | JSON | 200 |
| `PATCH` | `/api/apps/:appId/profiles/:profileId` | Web | JSON | 200 |
| `POST` | `/api/apps/:appId/profiles/:profileId/default` | Web | JSON | 200 |
| `POST` | `/api/apps/:appId/uninstall` | Web | JSON | 202 |
| `POST` | `/api/apps/:appId/update` | Web | JSON | 202 |
| `POST` | `/api/apps/:appId/update-check` | Web | JSON | 200 |
| `GET` | `/api/apps/catalog` | Web | JSON | 200 |
| `GET` | `/api/apps/catalog/custom` | Web | JSON | 200 |
| `PATCH` | `/api/apps/catalog/custom` | Web | JSON | 200 |
| `GET` | `/api/apps/jobs/:jobId` | Web | JSON | 200 |
| `GET` | `/api/apps/management` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions` | Web | JSON | 200 |
| `DELETE` | `/api/apps/sessions/:id` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id` | Web | JSON | 200 |
| `PATCH` | `/api/apps/sessions/:id` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/automation` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/display` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/logs` | Web | Binary/text stream | 200 |
| `GET` | `/api/apps/sessions/:id/novnc/vnc.html` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/branches` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/branches/checkout` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/branches/create` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/branches/delete` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/branches/tracking` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/changes` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/commits` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/context` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/delivery/fetch` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/delivery/publish` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/delivery/pull` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/delivery/push` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/diff` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/directories` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/discard/all-tracked` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/discard/worktree` | Web | JSON | 200 |
| `DELETE` | `/api/apps/sessions/:id/repository/files` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/files` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/files` | Web | JSON | 200 |
| `PUT` | `/api/apps/sessions/:id/repository/files` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/files/rename` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/files/search` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/index/stage` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/index/unstage` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/remotes` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/repository/worktrees` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/worktrees` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/repository/worktrees/remove` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/restart` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/screenshot` | Web | Binary/text stream | 200 |
| `GET` | `/api/apps/sessions/:id/snapshot` | Web | JSON | 200 |
| `POST` | `/api/apps/sessions/:id/stop` | Web | JSON | 200 |
| `GET` | `/api/apps/sessions/:id/tty` | Web | WebSocket | 101 then framed |
| `GET` | `/api/apps/sessions/:id/vnc` | Web | WebSocket | 101 then framed |
| `DELETE` | `/api/apps/sessions/:id/web/*` | Web | HTTP proxy | Upstream status |
| `GET` | `/api/apps/sessions/:id/web/*` | Web | HTTP/WS proxy | Upstream status |
| `OPTIONS` | `/api/apps/sessions/:id/web/*` | Web | HTTP proxy | Upstream status |
| `PATCH` | `/api/apps/sessions/:id/web/*` | Web | HTTP proxy | Upstream status |
| `POST` | `/api/apps/sessions/:id/web/*` | Web | HTTP proxy | Upstream status |
| `PUT` | `/api/apps/sessions/:id/web/*` | Web | HTTP proxy | Upstream status |
| `GET` | `/api/apps/sessions/state` | Web | JSON | 200 |
| `GET` | `/api/auth/status` | Public | JSON | 200 |
| `GET` | `/api/browser-tunnel` | Web | WebSocket | 101 then framed |
| `POST` | `/api/config-sync` | Web | JSON | 200 |
| `POST` | `/api/config-sync/:direction/:preset` | Web | JSON | 200 |
| `GET` | `/api/config-sync/folders` | Web | JSON | 200 |
| `GET` | `/api/config-sync/presets` | Web | JSON | 200 |
| `GET` | `/api/config-sync/programs` | Web | JSON | 200 |
| `GET` | `/api/diagnostics` | Web | JSON | 200 |
| `GET` | `/api/events` | Web | WebSocket | 101 then framed |
| `GET` | `/api/health` | Public | JSON | 200 |
| `GET` | `/api/instance/capabilities` | Web | JSON | 200 |
| `GET` | `/api/instance/status` | Web | JSON | 200 |
| `POST` | `/api/internal/agent-tools/invoke` | Agent tool | JSON | 200 |
| `DELETE` | `/api/internal/agent-tools/mcp` | Agent tool | MCP JSON/SSE | 200 |
| `GET` | `/api/internal/agent-tools/mcp` | Agent tool | MCP JSON/SSE | 200 |
| `POST` | `/api/internal/agent-tools/mcp` | Agent tool | MCP JSON/SSE | 200 |
| `PUT` | `/api/internal/ai-session-persistence-settings` | Node Agent | JSON | 200 |
| `PUT` | `/api/internal/codex-settings` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/model-catalog` | Node Agent | JSON | 200 |
| `PUT` | `/api/internal/model-catalog` | Node Agent | JSON | 200 |
| `PUT` | `/api/internal/model-environment` | Node Agent | JSON | 200 |
| `PUT` | `/api/internal/node-agent-connection` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/agent-runs/members` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/node-agent/agent-runs/:runId/members/:memberId` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/agent-runs/:runId/members/:memberId/close` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/node-agent/agent-runs/probe-state` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/ai-sessions/:id/close` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/ai-sessions/:id/close-for-story-deletion` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/ai-sessions/:id/messages` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/node-agent/ai-sessions/idle-retention` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/node-agent/ai-sessions/instance-idle-retention` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/drain` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/node-agent/process-identity` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/resume` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/shutdown` | Node Agent | JSON | 202 |
| `POST` | `/api/internal/node-agent/story-agent-tools/invalidate` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/node-agent/story-ai-sessions/:id` | Node Agent | JSON | 200 |
| `GET` | `/api/internal/node-agent/story-ai-sessions/:id/turns/:turnId` | Node Agent | JSON | 200 |
| `POST` | `/api/internal/node-agent/story-automation/ai-sessions` | Node Agent | JSON | 200 |
| `GET` | `/api/novnc/*` | Web | Static files | 200 |
| `POST` | `/api/repository/ai-session-workspace/checkout` | Web | JSON | 200 |
| `POST` | `/api/repository/ai-session-workspace/create` | Web | JSON | 200 |
| `POST` | `/api/repository/ai-session-workspace/inspect` | Web | JSON | 200 |
| `POST` | `/api/repository/workspace/branches/list` | Web | JSON | 200 |
| `POST` | `/api/repository/workspace/worktrees` | Web | JSON | 200 |
| `POST` | `/api/repository/workspace/worktrees/list` | Web | JSON | 200 |
| `POST` | `/api/repository/workspace/worktrees/move-to-main` | Web | JSON | 200 |
| `POST` | `/api/repository/workspace/worktrees/move-to-main/preflight` | Web | JSON | 200 |
| `POST` | `/api/repository/workspace/worktrees/remove` | Web | JSON | 200 |
| `GET` | `/api/status` | Web | JSON | 200 |
| `GET` | `/api/triggers` | Web | JSON | 200 |
| `POST` | `/api/triggers` | Web | JSON | 200 |
| `DELETE` | `/api/triggers/:configHash` | Web | JSON | 200 |
| `GET` | `/api/triggers/:configHash` | Web | JSON | 200 |
| `PATCH` | `/api/triggers/:configHash` | Web | JSON | 200 |
| `DELETE` | `/api/triggers/:configHash/deployments/:deploymentId` | Web | JSON | 200 |
| `POST` | `/api/triggers/:configHash/disable` | Web | JSON | 200 |
| `POST` | `/api/triggers/:configHash/enable` | Web | JSON | 200 |
| `POST` | `/api/triggers/:configHash/run` | Web | JSON | 200 |
| `GET` | `/api/triggers/runs` | Web | JSON | 200 |
| `GET` | `/api/workspace/status` | Web | JSON | 200 |

## Target-current Node extensions after `v0.0.46`

This section contains target-current routes that are not part of the `v0.0.46` compatibility baseline. It currently has eight routes.

| Method | Path | Auth | Transport | Success / notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/internal/instance-shell` | Node Agent | WebSocket | 101 then framed; post-`v0.0.46` only |
| `GET` | `/api/apps/install-environment` | Web | JSON | 200; post-`v0.0.46` only |
| `PUT` | `/api/apps/install-environment` | Web | JSON | 200; post-`v0.0.46` only |
| `POST` | `/api/apps/install-environment/test` | Web | JSON | 200; post-`v0.0.46` only |
| `POST` | `/api/apps/install-environment/prepare` | Web | JSON | 200; post-`v0.0.46` only |
| `GET` | `/api/ai-sessions/:id/repository/files/content` | Web | JSON | 200; post-`v0.0.46` only |
| `GET` | `/api/apps/sessions/:id/repository/files/content` | Web | JSON | 200; post-`v0.0.46` only |
| `GET` | `/api/ai-sessions/:id/turns/:turnId/tool-activity` | Web | JSON | 200; post-`v0.0.46` only |

## Additional contract families

- Repository routes are registered twice: once under `/api/ai-sessions/:id/repository/*` and once under `/api/apps/sessions/:id/repository/*`. Both bindings use the same repository service and ownership checks.
- `/api/apps/sessions/:id/web/*` registers exactly `DELETE`, `GET`, `OPTIONS`, `PATCH`, `POST`, and `PUT`; only `GET` performs the WebSocket upgrade. It is not a JSON API route.
- `/api/internal/node-agent/ai-sessions/:id/messages` and the public `/api/ai-sessions/:id/messages` belong to the AI Session provider control domain and must preserve the same structured provider error codes.
- `/api/events` carries the v1 event envelope by default and the compact envelope `v: "2026-08-25"` after a client subscribes with `eventEnvelopeVersion`.
- `streams.hello` is connection-scoped. It must not be broadcast to other WebSocket clients.
- Transient replay is connection-scoped and only applies to AI Session message deltas, Timeline items, and Timeline item deltas.
- `/api/ai-sessions`, `/api/ai-sessions/state`, `/api/apps/sessions`, and `/api/apps/sessions/state` expose authoritative snapshot revision plus `streamId`; `sinceRevision` requests require `streamId` and return only the versioned delta.

## Rust implementation status

- The Rust production router registers every baseline and target-current method/path/transport in this matrix. `test/controlled-instance-route-contract.test.js` parses Node TypeScript registrations and the Rust production router, then checks the Node baseline/extension split, exact methods, and WebSocket upgrade handlers in both directions.
- Two Rust registrations are explicitly outside the Node endpoint set: `/api/apps/sessions/{id}/web/` is the trailing-slash alias required because Axum wildcards do not match an empty trailing segment, and `/api/{*rest}` projects Node's structured API not-found handler. Neither is counted as a Node route.
- HTTP, WebSocket, Node Agent, private model/config, agent-tool, App Runtime, repository, Trigger, Config Sync, Story and Git credential domains have Rust handlers and contract tests in their owning crates.
- AI Session message and Timeline deltas use the same 20-50ms coalescing window (32ms default), insertion order, authoritative-event flush and `event-source-close` behavior as Node. Diagnostics expose the live coalescer counters instead of placeholders.
- Non-`/api` paths use the frozen UI's `index.html` with HTTP `200` for SPA route refreshes; unmatched `/api/*` paths remain structured `404` responses.
- The route matrix now records both the 201-route `v0.0.46` baseline and the 209-route target-current Node surface. Compatibility fixtures still need a separate per-route body/error corpus; registration parity alone is not a behavioral differential proof.

## Remaining fixture work

This document freezes paths, methods, auth, transport, and common status semantics. Per-route request/response fixtures, WebSocket replay fixtures, and error-code replay remain tracked by OpenSpec tasks 1.3-1.7 and 9.2. A route is not considered migrated until its Node fixture and Rust contract test both run through the differential harness.
