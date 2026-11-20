# 借鉴来源与项目取舍

调研日期：2026-11-04。以下是阅读过的公开 skill 源码固定版本，用于解释本 skill 的设计来源；它们不是安装依赖，不需要再次加载或执行其中脚本。本文为项目化归纳，没有整体复制外部 skill。

| 来源 | 采用的经验 | 本项目的适配 |
|---|---|---|
| [React compiler-port](https://github.com/react/react/blob/76baa3b5434fad315ece9cfd4d20d7a8d6c34a25/compiler/.claude/skills/compiler-port/SKILL.md) | 明确迁移单元、来源入口到 Rust crate、实际接线、定向测试和复核 | 本项目是运行时替换而非 compiler pass；已存在 Rust 文件仍需行为审计。复用当前 inventory，不引入它的 port-pass/compiler-review 子代理依赖 |
| [rust-java-migration](https://github.com/full-stack-skills/rust-skills/blob/b8a6af74af28ee86b8cbbbc3075cde0b31a5155e/skills/rust-java-migration/SKILL.md) | 固定双端基线、source-authoritative 分母、分开结构与语义状态、替代依赖按 contract 选型 | 保持现有 Rust crates 和 owner；不搬 Java 一对象一文件、固定行数门槛或每模块四文档制度，不重造归属索引 |
| [rust-java-migration-testing](https://github.com/full-stack-skills/rust-skills/blob/b8a6af74af28ee86b8cbbbc3075cde0b31a5155e/skills/rust-java-migration-testing/SKILL.md) | 分开来源行为、Rust 额外义务和风险驱动新增测试；mirrored 不等于 differential | 采用轻量场景表，保留完整 source case 与 fixture 来源；不把无关 monorepo 测试或强制新增 test crate 变成 gate |
| [rust-testing](https://github.com/rewrite-rs/skills/blob/ae0fd62485d071437ae5e6c4036c986b0dd122a0/skills/workflow/rust-testing/SKILL.md) / [DIFFERENTIAL-TESTING](https://github.com/rewrite-rs/skills/blob/ae0fd62485d071437ae5e6c4036c986b0dd122a0/skills/workflow/rust-testing/DIFFERENTIAL-TESTING.md) | recorded corpus、side-by-side、属性生成三种差分；说明归一化理由；为每个测试命名具体回归 | 本项目 errors/message、原始 bytes、revision/时间/顺序有时就是协议，不能套通用排序/时间/换行规则。来源未运行明确记 not-run，不能通过日志被捕获的绿色测试隐去 |
| [TDD](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/tdd/SKILL.md) | 从可观察边界逐条建立失败与修复，expected 独立于实现，避免一批想象测试 | 范围来自项目看板与既有用户授权，不逐个测试再次要求用户确认；需要时允许私有 owner 不变量测试和共同根因重构 |
| [audit-external-api-port](https://github.com/krishnendudakshi2002/skills/blob/b7cb2efa819c8ba5c570bda1735f6152a13a7d52/skills/audit-external-api-port/SKILL.md) | 独立重建行为；正向追踪场景到实现、反向追踪新增逻辑到来源；按影响分级，证据缺失不认证 | 不引入 TagMango 的目录、issue packet、Mongo 或外部 API 形状要求；只读请求保持只读，修复请求继续执行已授权修复 |

这些来源并非完全一致。本项目选择“先固定一个有限场景集合，再按反馈修复共同根因”：既避免逐对象无休止漫游，也不先写一大批没有来源输出的测试。整体完成需要声明分母闭环；每轮只推进一个可验收片段，不能把局部绿色提升为全迁移等价。
