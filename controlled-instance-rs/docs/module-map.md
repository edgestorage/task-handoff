# Node to Rust Module Ownership

The exceptions approved by the migration are the JavaScript launcher adapter, the OpenCode plugin adapter, and the frozen `packages/controlled-instance-ui` frontend. All other controlled-instance runtime modules have a Rust owner and at least one referenced test file.

## Status semantics

- **Ownership implemented** means a Rust owner exists and the referenced test file exists. It does not by itself mean full Node/Rust behavioral parity, platform runtime proof, or 109 acceptance.
- **Unit/contract tested** means focused Rust tests exercise the declared behavior. It does not mean the route, provider, CLI, persistence, and platform matrix has a complete differential fixture.
- **Differential partial** means the current `scripts/controlled-instance-differential.mjs` comparison covers the area only for its scripted HTTP scenarios. WS, CLI, persistence, provider, and most error/body fixtures are still missing.
- **Platform runtime unverified** means platform-specific code exists and may compile for the target, but has not passed runtime smoke or differential acceptance on that platform.
- **Frozen/adapter exception** means code is deliberately retained outside the Rust business migration and is covered by boundary checks.

The route surface has 201 explicit `v0.0.46` registrations, including five WebSocket upgrades. Target-current Node has 202 registrations; the only post-baseline extension is `GET /api/internal/instance-shell`. Route registration parity is not a behavioral differential proof.

| Node module | Rust owner | Current state |
| --- | --- | --- |
| `apps/controlled-instance-image/src/cli.ts` | `crates/cli` | web/default command, validation, local lock, Git credential/SSH/askpass helpers and provisioning helper implemented; unit/contract tested, macOS/Windows launcher runtime pending |
| `packages/controlled-instance/src/index.ts` | `crates/instance` | instance crate and server implemented; route parity contract-tested, full body/status/error differential pending |
| `packages/controlled-instance/src/opencode-story-plugin.ts` | JS adapter exception | forwarding adapter implemented; migration and artifact gates enforce that it carries no business logic |
| `packages/controlled-instance/src/story-tool-contract.ts` | `crates/protocol` | Story tool schemas and policy contract implemented with the Rust bridge |
| `repository/context.ts`, `changes.ts`, `files.ts` | `crates/workspace` | repository context, changes and versioned file services implemented with route contract tests |
| `repository/branches.ts`, `git-process.ts` | `crates/workspace` | Git CLI adapter, branch operations, diff/status parsing and repository mutations implemented with contract tests |
| `repository/worktrees.ts`, `mutation-queue.ts` | `crates/workspace` | worktree registry, generation migration, serialized mutations and recovery behavior implemented |
| `repository/routes.ts` | `crates/instance` | repository route wiring implemented |
| `triggers/store.ts`, `manager.ts`, `executor.ts` | `crates/workspace` | trigger persistence, scheduler, manual runs, event matching and restart semantics implemented |
| `web/auth.ts` | `crates/instance/src/auth.rs` | web token resolution and constant-time comparison implemented |
| `web/events.ts` | `crates/instance/src/events.rs` | event envelope, sequence, transient retention/replay, settled-item pruning, compact wire projection and slow-consumer close implemented |
| `web/status.ts` | `crates/instance/src/state.rs` | status, capability and workspace projection implemented |
| `web/server.ts` | `crates/instance/src/server.rs` | all 201 baseline and one target-current Node registrations are present; the route test compares the Node TypeScript AST, matrix and Rust router, but not response bodies or every error/status path |
| `web/node-agent-client.ts` | `crates/instance/src/node_agent_client.rs` | register/heartbeat, protocol-header projection, reconnect backoff, 404 re-registration, connection update, Git credential, Story, agent-run and private-config requests implemented |
| `web/instance-shell.ts` | `crates/instance/src/instance_shell.rs` | exec/PTY, resize, signals, activity limits, drain cleanup, registration-token auth and subprotocol contracts implemented; Unix uses `libc::openpty`/process groups, Windows uses ConPTY/Job Object code, Windows runtime semantics remain unverified |
| `web/browser-tunnel.ts` | `crates/instance/src/browser_tunnel.rs`, `crates/protocol/src/browser_tunnel.rs` | framed tunnel, loopback aliases, half-close, bounded send budget, auth and close-code contracts implemented |
| `web/app-management.ts` | `crates/app-runtime` | app management jobs, status projection and cleanup implemented |
| `web/app-recipe-executor.ts` | `crates/app-runtime` | install, update and uninstall recipes implemented |
| `web/app-update-check.ts` | `crates/app-runtime` | update checks implemented |
| `web/config-sync.ts` | `crates/workspace/src/config_sync.rs` | presets, import/export, folder validation, symlink rejection and batch results implemented |
| `web/private-model-catalog.ts` | `crates/protocol/src/model_config.rs`, `crates/instance/src/private_model.rs` | direct/relay catalog sanitize, private-config loading, stable-identity selection resolution and target/session error semantics implemented |
| `web/codex-model-config.ts` | `crates/protocol/src/model_config.rs`, `crates/instance/src/private_model.rs` | managed providers, auth/config.toml, settings, bounded backups, atomic writes and deterministic provider ids implemented |
| `web/claude-model-config.ts` | `crates/instance/src/private_model.rs` | Claude `settings.json`, stale auth-token removal and managed environment shadowing implemented |
| `web/session-title-model.ts` | `crates/ai-session` | title projection and provider-backed title generation implemented |
| `web/git-credential-broker.ts` | `crates/instance/src/git_credentials.rs`, `crates/protocol/src/git_credentials.rs` | local broker, per-operation HTTPS resolution, SSH agent proxy, release cleanup, environment injection, named-pipe support and CLI helpers implemented; Windows runtime e2e remains pending |
| `web/git-provisioning-credentials.ts` | `crates/instance/src/git_provisioning.rs`, `crates/protocol/src/git_credentials.rs` | runtime credential discovery, scope normalization, longest-prefix matching, ambiguity/host-key failures and provisioning helpers implemented |
| `web/git-transport.ts` | `crates/core/src/git_transport.rs` | HTTPS credential request projection, strict SSH invocation parsing and non-shell SSH execution implemented |
| `web/story-tools.ts` | `crates/instance/src/story_tools.rs` | Story content/tool policy and invocation implemented |
| `web/story-agent-tool-bridge.ts` | `crates/instance/src/story_agent_tool_bridge.rs` | internal agent-tools bridge implemented |
| `web/story-tool-policy-cache.ts` | `crates/instance/src/story_tools.rs` | Story policy loading and invalidation implemented |
| `web/agent-run-member-bindings.ts` | `crates/instance/src/agent_run_bindings.rs` | agent-run member binding implemented |
| `web/agent-run-member-status.ts` | `crates/instance` | agent-run member binding, status projection and close contracts implemented |
| `web/ai-session-authority-events.ts` | `crates/instance` | authority snapshot/patch projection implemented with monotonic revisions |
| `web/ai-session-message-delta-coalescer.ts` | `crates/instance/src/ai_session_delta_coalescer.rs` | 20-50ms coalescing (32ms default), insertion-order flushing, terminal/authoritative triggers and diagnostics implemented |
| `web/web-proxy-helpers.ts` | `crates/instance` | proxy retry, header/cookie forwarding, binary streaming and WebSocket upgrade implemented |
| `packages/ai-session-runtime/src/index.ts` and session state modules | `crates/ai-session` | Session persistence, revisions, history, queue, Timeline store/read/sync and attachments implemented with focused Rust tests; provider and persistence differential fixtures remain incomplete |
| `packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts` | `crates/ai-session` | Node-compatible draft/manifest/blob store, runtime-path staging, ETag content and queue attachment edits implemented |
| `packages/ai-session-runtime/src/ai-session-turns.ts` | `crates/ai-session` | turn index/body revisions and reducer projection implemented; remaining differential fixtures are tracked in OpenSpec |
| `packages/ai-session-runtime/src/codex-app-server*` | `crates/ai-session` | stdio JSON-RPC, thread/turn/approval control, resume/fork, durable/live Timeline and managed model provider selection implemented; fake app-server integration tests pass, live-provider differential remains pending |
| `packages/ai-session-runtime/src/claude-control-sock.ts` | `crates/ai-session` | Claude control socket provider implemented with focused tests; live-provider differential remains pending |
| `packages/ai-session-runtime/src/opencode*` | `crates/ai-session` | OpenCode HTTP/SSE provider, message/timeline deltas and lifecycle handling implemented with mock-provider tests; live-provider differential remains pending |
| `packages/app-runtime/src/runtime.ts`, `types.ts` | `crates/app-runtime` | session lifecycle, shared resources, TTY, display, VNC and process ownership implemented; unit/contract and fake app-server integration tested, macOS/Windows runtime smoke pending |
| `packages/app-runtime/src/catalog.ts`, `managed-apps.ts` | `crates/app-runtime` | catalog, inventory and managed app definitions implemented through a registry |
| `packages/app-runtime/src/managed-app-definitions/**` | `crates/app-runtime` | provider/registry app definitions implemented without app-id branches in the executor |
| `packages/app-runtime/src/log-retention.ts` | `crates/app-runtime` | bounded logs and rotation implemented |
| `packages/core/src/storage/paths.ts` | `crates/core/src/paths.rs` | implemented |
| `packages/core/src/storage/atomic-write.ts` | `crates/core/src/atomic.rs` | implemented |
| `packages/core/src/core/process-singleton-lock.ts` | `crates/core/src/singleton_lock.rs` | directory lock, owner, start identity and local lock implemented |
| `packages/core/src/core/local-controlled-instance-lock.ts` | `crates/core/src/singleton_lock.rs` | implemented |
| `shared/process-start-identity.cjs` | `crates/core/src/process.rs` | Linux/macOS/Windows code paths implemented; Linux/macOS unit tested, Windows runtime unverified |
| `packages/protocol/src/control-plane.ts` capability/status portions | `crates/protocol/src/status.rs` | initial wire model implemented |
| `packages/protocol/src/events.ts` envelope/topic portions | `crates/protocol/src/event.rs` | initial wire model implemented |
| `packages/protocol/src/events.ts` transient subscription/compact envelope | `crates/protocol/src/event.rs` | transient subscription predicate and compact envelope encoding implemented |
| Protocol version constants | `crates/protocol/src/versions.rs` | implemented |
| Entity ID contract | `crates/protocol/src/id.rs` | Crockford time-ordered generator implemented |
| `packages/controlled-instance-ui/**` | Frozen UI exception | source, routes, stores and interactions remain Vue/TypeScript |
| Artifact `ui/**` | Frozen static assets | Rust serves the existing build; no server-side logic or Node fallback allowed |

## Verification status by area

| Area | Implementation status | Current verification | Remaining evidence |
| --- | --- | --- | --- |
| CLI and launcher ABI | Rust CLI plus approved JS launcher adapter implemented | Rust contract tests and launcher boundary checks | macOS/Windows launcher, signal forwarding, and artifact runtime smoke |
| HTTP route surface | 201 `v0.0.46` + one target-current registration implemented | Node AST, matrix, and Rust router parity test | Per-route request/response/status/error fixtures; current differential script covers selected HTTP steps only |
| WebSocket/event bus | Subscription, replay, compact envelope, slow-consumer close, delta coalescer implemented | Focused Rust tests; Local/Docker `.21` event acceptance rerun completed on 109 | Unified WS fixture corpus and repeatable Node/Rust differential comparison |
| AI Session, attachments, providers | Session/state, attachments, Codex, Claude, OpenCode implemented | Focused Rust tests and fake/mock provider integration | Representative recorded provider/error streams and live differential fixtures |
| App runtime and PTY | Catalog, sessions, display/VNC, logs, proxies, Unix PTY, Windows ConPTY code implemented | Focused unit/contract and fake Codex app-server integration tests | Windows ConPTY/Job Object runtime, resize/exit/signal semantics, macOS runtime, app lifecycle differential |
| Repository, worktrees, triggers, Git | Implemented with focused repository/Git/worktree/trigger tests | Unit/integration tests using temporary repositories | Conflict, credential, config-sync symlink, restart, and full Node/Rust differential matrix |
| Protocol/core persistence | Wire models, IDs, paths, atomic writes, locks, reconnect implemented | Focused Rust tests and migration-boundary checks | Persistence samples/sanitize fixtures and cross-version Node/Rust read/write evidence |
| Frozen UI | Deliberately not migrated | Frozen boundary and artifact checks | Real-page regression against Rust runtime remains an OpenSpec acceptance task |

## Contract references

- `docs/http-route-matrix.md` freezes the `v0.0.46` route/path/auth/transport surface (201 registrations total, five of them WebSocket upgrades) and the target-current Node surface (202 registrations, with only `GET /api/internal/instance-shell` added). `test/controlled-instance-route-contract.test.js` extracts routes from the Node TypeScript AST and fails if the matrix or Rust router drifts; response-body and error fixtures remain separate work.
