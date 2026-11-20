# 差分与验收

## 每个工作单元的最小记录

在看板活动记录下使用这些字段；按行为添加场景，不机械补满无关矩阵：

```text
单元 / 状态 / 当前下一步：
范围与完成条件：
Node/Rust HEAD + 相关 dirty 文件；兼容 tag；工具链/平台：
Node 入口 → 权威 owner → 输出；Rust 对应调用路径：
场景 ID | 来源测试/协议 | 输入与初始状态 | 观察点 | 证据标签 | 结论
关键复现：Node 原始输出 / 旧 Rust 原始输出 / 修复后输出
改动文件与不变量：
验证命令 / cwd / 实际结果 / 日志或 fixture：
未执行、失败、工具故障、外部依赖、已知 flaky：
下一单元与选择理由：
```

结论分别写 `match`、`mismatch`、`not-run`、`harness-error`、`decision-needed`。非 match 不得被统计为已对齐；同一测试含多场景时分别记录场景数与测试数，不能混加。无来源输出的 Rust 新测试可证明不变量，不能标为 differential。

## 选择 harness

1. 固定 golden：由 Node 生成并复核输入/输出，双方执行同一 fixture；保存来源 SHA/dirty 状态。适合已知 HTTP、projector、历史持久化输入。
2. 同批 side-by-side：各自隔离的相同初始状态，执行同一组 action，比较结果与副作用。适合队列、重试、事件、取消和恢复。
3. 属性生成：只有针对明确输入空间缺口时才引入，固定 seed，保存最小失败样本；包含合法业务输入，避免只生成 schema 拒绝。

来源执行失败不是 match。缺 Node 依赖、运行时或外部系统时记录 not-run/harness-error，不能用 Rust expected 自证、静默 skip 或刷新快照变绿。运行 source suite 时先检查 runner 配置和具体 case；不要求把整个 monorepo 的无关测试纳入 instance 迁移分母。

## 比较什么

| 边界 | 必须保留的可观察关系 |
|---|---|
| HTTP / MCP | method/path/query/body bytes、parser/auth 顺序、status、相关 headers、error code/body、null/缺失、SSE framing；helper 通过不等于真实 wire 通过 |
| WS / 快照 | HTTP snapshot 的 revision 与后续事件、previousRevision、顺序、gap/reconnect 恢复、订阅/权限边界、慢消费者与断开释放 |
| 状态机 / queue | 同一 session/message/queue ID、transition 前后状态、单调 revision、幂等重试、失败后的 owner 和事件 |
| 持久化 | current/N-1 输入、migrate/sanitize、未知字段、重开 owner 后的结果、原子写失败与 durable/in-memory 发布顺序 |
| Provider | 同一关联 ID 的 chunk/event/action 顺序、partial/final、tool lifecycle、approval/interrupt/steer、断连与重入；projector fixture 只是其中一层 |
| 进程 / 文件 | 谁创建、谁持有、何时释放、失败/取消后的资源、共享 consumer 计数、不得接管外部 app-server/宿主 CLI |
| CLI / artifact | argv、stdin/stdout/stderr、exit/signal、配置与私有版本解析、升级救援和回滚；cross compile 不等于平台运行 |

只归一化已证明不属于该 contract 的不确定性，并把规则放在 harness 旁：

- 随机 ID 可双射映射，但必须保留引用一致、唯一、生命周期和复用关系。
- 时间可固定 clock；TTL、顺序、expiry 边界是断言，不应删除。
- JSON 对象键顺序仅在协议无顺序语义时忽略；数组、错误顺序、原始 bytes、签名/hash 输入不排序。
- 临时根路径可映射；路径身份、边界、编码、文件名和实际内容不替换。
- revision/sequence/streamId 不能统一忽略；允许基线平移时须保留单调性、差值、previousRevision 和 reconnect 关系。

现有 `scripts/controlled-instance-differential.mjs` 是部分 HTTP smoke，含广泛 ignoredKeys（包括 revision/sequence/streamId）。可运行它验证已覆盖的 smoke，不能以其 matched 汇总证明完整事件/状态差分；新增此类断言需有独立的严格比较。

## 现有命令

从仓库根目录确认基线/索引/注册：

```sh
git status --short
git rev-parse HEAD
git tag --merged main --sort=-version:refname
node scripts/check-controlled-instance-rust-migration.mjs
node --test test/controlled-instance-route-contract.test.js
```

tag 列表中只选择符合支持窗口的稳定版本，不把 prerelease 当稳定基线。已确定目标版本时排除不低于目标的 tag。

按本轮边界选 Node suite，先用 `rg --files test packages` 确认文件/runner：

| 范围 | 现有测试起点 |
|---|---|
| Session / queue / events | `test/ai-session-create.test.js`、`test/ai-session-queue-*.test.js`、`test/ai-session-authority-events.test.js`、`test/ai-session-turn-body-revision.test.js` |
| Attachment | `test/attachment-route-parity.test.js`、`test/ai-session-attachments.test.js`、`test/ai-session-conversation-attachments.test.js`、`test/ai-session-attachment-draft-streams.test.js` |
| HTTP / repository / MCP | `test/repository-*.test.js`、`test/mcp-body-parity.test.js`、route contract |
| Provider | `test/{codex,claude}-projection-parity.test.js`、`test/opencode-adapter.test.js`；OpenCode TS runner 按 package manifest 查找 |
| App / trigger / persistence | `test/app-session-event-diagnostics.test.js`、`test/triggers.test.js`、`test/persistence-retention.test.js`，再定位所属包测试 |

Rust 定向命令从 `controlled-instance-rs/` 执行，package 名以实际 Cargo.toml 为准，例如：

```sh
cargo test -p controlled-instance-ai-session --lib attachments::tests
cargo test -p controlled-instance-instance --lib ai_session_queue_
```

实现阶段结束时在同目录执行：

```sh
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

再从根目录运行本轮相关 Node suites、migration checker 和 `git diff --check`。无需因文档或 skill 修改重跑整个产品 suite。不要盲目追加 all-features/Miri/fuzz 或安装新工具；只有该单元机制与支持目标需要时才增加门禁。记录原始失败和复核结果，不能反复重试挑选一份绿色日志掩盖 flaky。

## 环境与总体完成

临时 fixture、mock provider/socket、in-process HTTP 只能证明测试边界。隔离 data/runtime/config/XDG/CLI home，停止且清理测试自有资源，不扫描、接管或杀既有产品进程。使用事件/可控时钟和有界超时，不让固定 sleep 成为唯一完成判据；这不授权产品内部轮询。

真实运行态、平台和升级/回滚验收按项目流程；当前默认唯一测试目标 `192.168.139.109`，部署操作须有任务授权。不把本机模拟或 cross compile 记作 Windows/WSL2/macOS runtime 通过。没有执行的支持平台、兼容/救援和回滚仍保留验收缺口。
