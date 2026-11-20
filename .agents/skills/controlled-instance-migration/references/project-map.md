# 项目导航

以下路径从当前仓库根目录解析。先读对应源码与已有测试，不把导航表当作行为规范。

## 当前资料的职责

| 资料 | 用途与限制 |
|---|---|
| `controlled-instance-rs/docs/migration-inventory.json` | Node import closure 到 Rust owner/tests 的唯一归属索引；implemented 不表示逐场景差分通过 |
| `scripts/check-controlled-instance-rust-migration.mjs` | 验证归属、冻结 UI、批准 adapter、无 Node 业务回退；不验证 HTTP/WS 行为 |
| `controlled-instance-rs/docs/http-route-matrix.md` | method/path/WS 注册集合；不能替代 body/status/error/header/stream 验证 |
| `knowledge/controlled-instance-rust-parity-plan.md` | 当前工作指针、优先级和场景验收记录；不另建源码归属映射 |
| `knowledge/controlled-instance-rust-parity-audit-20261104.md` | 历史复现、变更、验证和阶段断点 |
| `knowledge/controlled-instance-rust-migration.md` | 总体替换状态、运行态历史及仍未闭环边界；历史版本不覆盖新基线 |
| `knowledge/update-test-control-plane.md` | 经授权的真实环境更新/验收流程；遵守当前 AGENTS 的目标限制 |

## 入口与权威 owner

| 边界 | Node 查找入口 | Rust 查找入口 |
|---|---|---|
| CLI / launcher | `apps/controlled-instance-image/src/cli.ts` | `controlled-instance-rs/crates/cli`、`controlled-instance-rs/packaging` |
| HTTP / MCP / auth / proxy | `packages/controlled-instance/src/web` | `controlled-instance-rs/crates/instance/src/server.rs`、`src/server/` |
| WS / revision / reconnect | `packages/controlled-instance/src/web/events.ts`、`ai-session-authority-events.ts` | `controlled-instance-rs/crates/instance/src/events.rs`、`ai_session_coordination.rs` |
| AI Session / queue / persistence | `packages/ai-session-runtime/src/ai-session-{registry,control}.ts`、`src/ai-session/` | `controlled-instance-rs/crates/ai-session/src/{lib,provider,persistence}.rs` |
| 附件 / stream owner | `packages/ai-session-runtime/src/ai-session-{conversation-attachment-store,attachment-draft-streams}.ts` | `controlled-instance-rs/crates/ai-session/src/attachments.rs`、`crates/instance/src/server/attachment_source.rs` |
| Provider | `packages/ai-session-runtime/src/{codex-app-server,opencode,claude-control-sock}*`、`packages/core/src/core/claude-control-sock.ts` | `controlled-instance-rs/crates/ai-session/src/{codex_app_server,opencode,claude_control_sock}.rs` |
| App / TTY / managed CLI | `packages/app-runtime/src`、`packages/core/src/core` | `controlled-instance-rs/crates/app-runtime`、`crates/core` |
| Repository / worktree / config-sync / trigger | `packages/controlled-instance/src/{repository,triggers,web}` | `controlled-instance-rs/crates/workspace` |
| 公共协议与读取 sanitize | `packages/protocol/src`、各所属 owner | `controlled-instance-rs/crates/protocol`、各所属 owner |

这些目录只是搜索起点。具体 Node 文件到 Rust owner 必须回查 inventory 与真实 import/caller；不要从名称相似推定行为对齐。

## 已有共享样本

- Repository / MCP / attachment：`controlled-instance-rs/crates/instance/tests/fixtures/*parity.json`；Node consumer 是 `test/{repository-route,attachment-route,mcp-body}-parity.test.js`。
- Repository diff：`controlled-instance-rs/crates/workspace/tests/fixtures/repository-diff-parity.json`，Node `test/repository-changes.test.js`。
- Provider projector：`controlled-instance-rs/crates/ai-session/tests/fixtures/{codex,claude,opencode}-projection-parity.json`；Node consumers 为 `test/{codex,claude}-projection-parity.test.js` 和 `packages/ai-session-runtime/test/opencode-projector.test.ts`。
- 这些样本是部分 projector/HTTP 证据，不是完整 provider 录制会话、真实 chunked wire 或 WS reconnect 证据。先找可扩展 harness，避免每个差异各造一套临时服务。

## 基线检查的已知起点

创建本 skill 时（2026-11-04），main 可达最新稳定 tag 为 `v0.0.47`，inventory 的 compatibilityBaseline 和路由矩阵仍写 `v0.0.46`。后续使用必须重新查询。先审计两 tag 的边界差异及 target-current 增量，再更新对应资料和测试；只换版本文字不构成兼容验证。

Node/current 含大量未提交修复时，HEAD 不足以固定 oracle。记录实际相关文件差异、fixture 和运行命令；重建 bundle 时确认它来自同一工作树。禁止把旧 dist 当作当前 Node 的证据。
