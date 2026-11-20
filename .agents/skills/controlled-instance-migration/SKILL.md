---
name: controlled-instance-migration
description: "推进 TaskHandoff controlled instance 从 Node/TypeScript 到 Rust 的行为迁移、差异修复和验收；适用于迁移审计、补齐逻辑、继续补、续接迁移或建立差分测试。以项目验收看板选择工作单元，验证 HTTP/WS、状态机、持久化、provider 和进程所有权。不用于一般 Rust 开发、Control Plane/Node Agent 重写或日常部署。"
---

# Controlled Instance Migration

把每次迁移推进变成可复现、可验收、可接续的工作单元。先说明本轮覆盖的用户行为和完成条件，再核对 Node 决策链、Rust 接线和双方观察结果。源码存在、两边测试各自通过、路由注册一致，都不能单独证明行为等价。

## 入口与续接

在仓库根目录工作，先读适用的 `AGENTS.md`、`AGENTS.local.md` 和工作树状态，保留已有修改。

1. 读 `knowledge/controlled-instance-rust-parity-plan.md` 的“当前指针”和对应工作单元；再查两份历史记录中与它有关的证据，避免重读全部历史后重新漫游。
2. 以 `controlled-instance-rs/docs/migration-inventory.json` 为源码归属索引，运行现有 migration checker 验证索引；不能另建一份模块归属权威清单。索引的 implemented 仅表示实现归属。
3. 固定当前 Node/Rust 的 HEAD、相关未提交差异、工具链、目标平台和兼容 tag。未确定目标版本时，兼容基线按 main 可达的最新稳定 tag；已确定目标时按项目支持窗口选择，不能照抄 inventory 中的旧版本。
4. 用户指定模块就选该模块；“继续补/继续迁移”接续当前指针。指针已完成时，选看板中最高优先级且依赖满足的单元。只读审计或规划请求保持只读，不进入实现。

若本地 knowledge 看板缺失，在允许文档写入时从现有 inventory、任务记录和实际 fixture 建立看板；未知项保留未验证，不凭历史测试总数回填完成。只读请求把范围与下一步直接写在响应里。

路径和既有测试见 [project-map.md](references/project-map.md)；选定验证边界后读 [verification.md](references/verification.md)。需要理解借鉴取舍时读 [sources.md](references/sources.md)。所有仓库路径相对仓库根目录，不相对 skill 安装目录。

## 先限定本轮验收范围

在看板活动记录里写清：

- 单元 ID、用户可见行为、Node 入口到权威 owner 的路径、Rust 对应入口及其调用方。
- 可枚举的场景集合：主要成功路径、重要拒绝路径，以及该行为涉及的重试/取消/重启/事件转换。优先复用已有 source tests，不从空白想象一批 Rust 测试。
- 每个场景的输入、初始状态、预期输出与可观察副作用；需保护的统一不变量。
- 本轮不覆盖的边界、验证命令和完成条件。未经执行的场景仍是未验证，不能从分母移走。

默认推进一个有明确结束条件的单元；发现多个差异共享根因时可以一起修。新发现若不阻断本轮不变量，记入看板后续项。优先数据丢失、权限/进程所有权、常用会话链路、事件和恢复，再补低影响输入角落；不要因为某模块刚修过就无限延伸。

## 证据 → 修复 → 复核

### 1. 重建来源行为

从 Node 实际注册入口追踪 parser/auth → service/adapter → 状态机/存储 → 响应/事件，包含相关 helper；同时确认 Rust 真实调用链，不只看同名函数。记录同一 session/message/attachment/queue/provider ID 在各层的输入、输出和变化。

当前 Node 实现是迁移目标；发布 tag 用来检查跨版本兼容和历史数据。两者行为冲突时区分演进与缺陷，不自行把旧 bug 定为新产品规则。不能用 UI 过滤或补写缓存来纠正权威源。

### 2. 在正确边界复现

优先给现有 Node/Rust harness 加同一命名场景，固定输入和初始状态；保留 Node 原始结果及旧 Rust 的业务断言失败。源码推测、编译失败、测试工具故障分别记录，不能算成已复现产品差异。

比较本场景有关的完整观察：响应 status/body/header、状态转换、持久化 owner、文件/子进程副作用和事件顺序。需要证明恢复就真的重开 store/重启测试自有进程；需要证明 transport 就不能只测 helper。新测试写明会抓住什么回归，避免仅 is_ok/is_err 或增加计数。

沿用成熟共享 fixture，expected 来自已固定的 Node 输出或明确协议，而非 Rust 实现自身。归一化必须逐字段说明；revision/sequence、关联 ID 的相等关系、排序、空值/缺失、TTL 和字节内容不能宽泛删掉。细则见验证参考。

### 3. 修正权威边界

优先修 owner、状态机和 adapter 的共同不变量，并检查全部调用点与实际 router/provider 接线；采用 Rust 原生 ownership/error/async 模型，无需机械复制 TS 文件或类结构。新增依赖前检查现成库能否满足本项目协议与生命周期边界。

覆盖 Rust 引入的额外风险：Drop/提前返回、部分初始化、取消、旧任务或旧 generation、锁与 await、慢消费者、写盘成功与内存发布顺序。必要重构服务于本轮根因，不借迁移重做无关模块。

Node-agent 与 instance 是内部同版本域；对外客户端、control-plane、持久化历史数据仍按 N-1 检查。不要为了内部实现新增可推导的公共/持久化字段，或回退到 Node 执行业务逻辑。

### 4. 分层验证和双向追踪

先跑本单元定向回归；修复稳定后执行本阶段相关完整 gates。无新修改、失败或未解疑点时，不反复重跑已通过检查。命令和运行范围见验证参考。

自查两个方向：每条验收场景是否到达真实生产分支并观察副作用；新增的每条分支/默认值/状态变更是否有来源行为或项目不变量。复核错误路径、旧数据、资源释放和事件发布，不能只 review happy path。委派仅在用户或适用指令明确要求时使用，本 skill 不要求启动子代理。

## 状态与交付

看板任务状态使用 `queued → active → covered`；缺证据可保留 active 并写阻塞，或记 `pending-external`。这里的 covered 只针对列明的场景集，不表示模块或迁移整体完成。证据标签独立记录：`static`、`rust-local`、`mirrored`、`golden-diff`、`live-diff`、`runtime`、`rollback`；它们不是自动递增的完成等级。

- `mirrored`：Rust 承接命名 Node case 的输入与断言，尚未比较固定来源的实际输出。
- `golden-diff/live-diff`：固定来源、相同输入、逐场景结果可比较；仍需标明覆盖范围。
- `runtime/rollback`：仅证明所记录平台、版本和边界，不能由编译成功或 mock 推导。

每阶段更新看板当前指针/场景记录、`knowledge/controlled-instance-rust-parity-audit-20261104.md` 证据与命令、`knowledge/controlled-instance-rust-migration.md` 简短现状。日志不能只存在 `/tmp`：至少把复现输入、关键原始输出和结果摘要写入任务文档；可复用 fixture 留在仓库测试目录。

本轮完成需：范围内场景有结论、确认差异已修复且回归通过、调用链/副作用复核完成、相关 gates 有实际结果、未验证项和下一指针已写明。没有发现差异也可以形成有效覆盖证据，不为凑修复而改代码。

整体替换验收另需覆盖全部已声明边界、来源场景及支持平台、升级/救援/回滚和运行态资源，不以测试总数或 implemented 比例宣称完成。输出本轮行为变化、验证证据、剩余风险和下一单元；没有用户明确授权，不提交、不部署、不切换默认 artifact，也不创建 OpenSpec。
