# Mobile Control Plane Client Baseline

本文记录 `add-mobile-control-plane-client` 开始实施时的 AI session 权威链路、Control Plane contract、现有验证入口和首发范围。实时恢复语义以 [session-event-streams.md](./session-event-streams.md) 为准；本文只补充移动客户端需要保持的边界。

## 身份与权威边界

移动客户端中的完整会话键为：

```text
(controlPlaneId, instanceId, sessionId)
```

各字段在现有链路中的职责如下：

| 字段 | 权威来源 | 逐层传递方式 | 移动端约束 |
| --- | --- | --- | --- |
| `controlPlaneId` | 已验证 Control Plane profile 的签名身份 | 当前服务端 AI session payload 不携带该字段 | 由 profile/store/query key 在最外层补充，不能用 origin、显示名或 session cookie 代替 |
| `instanceId` | controlled instance / Control Plane 实例记录 | event `meta.instanceId`、event `scope.instanceId`、聚合结果 `instances[].instanceId` 和 instance-scoped route | 所有 snapshot、delta、message delta、draft、upload 和 action 必须按它隔离 |
| `sessionId` | controlled instance `AiSessionRegistry` 的 `AiSessionStatus.id` | snapshot/patch/removed、message delta、route param 和 action result 的 `aiSessionId` | 只在同一 `controlPlaneId/instanceId` 内唯一，不能跨实例合并 |
| `providerSessionId` | Codex/Claude provider adapter | `AiSessionStatus.providerSessionId`、history/resume/create result、message delta 和诊断事件 | 用于 provider/history 关联，不作为客户端唯一 session key |
| `streamId` | controlled instance 进程内 session stream epoch | state/snapshot meta、delta response、`streams.hello`，由 node-agent 透明转发并由 Control Plane 按实例聚合 | stream 变化必须先恢复 snapshot；旧 stream 的 delta 不能建立新 epoch |
| `revision` | controlled instance 当前 stream 的单调版本 | state/snapshot meta、delta response 和 `streams.hello` descriptor | 只接受连续 revision；duplicate/stale 忽略，gap 进入 delta/snapshot 恢复 |

## 端到端状态链路

1. Protocol：`packages/protocol/src/ai-sessions.ts` 定义严格 schema、`AiSessionEventTopic`、snapshot/patch/removed/message-delta 类型，以及 `applyAiSessionStreamEvent` 的 `applied/duplicate/stale/gap/snapshot-required` 结果。
2. Controlled instance：`packages/controlled-instance/src/web/server.ts` 从 `AiSessionRegistry` 生成 `AiSessionsState`，维护进程级 `aiSessionStreamId` 与 revision，发布 `ai.sessions` 事件，并提供 snapshot/delta/action API。
3. Node-agent：`packages/control-plane/src/node-agent/events.ts` 订阅实例 `ai.sessions`，验证通用 envelope 后以 `node-agent.event.forwarded` 透明转发；它补充传输 scope，但不投影或重写 session payload。
4. Control Plane：`packages/control-plane/src/control-plane/sessions/ai-session-aggregator.ts` 按 `instanceId` 调用共享 reducer，保存最新投影，针对 gap/stream reset 读取实例 delta 或 snapshot；`session-routes.ts` 将聚合快照和实例 action 暴露给用户 API。
5. Control Plane UI：`packages/control-plane-ui/src/apps/control-plane/useControlPlaneEvents.ts` 消费 `streams.hello` 和实时事件，`useAiSessionStore.ts` 按实例恢复并调用共享 reducer，`useStreamingMessagesStore.ts` 按 `instanceId/sessionId/turnId/itemId` 保存流式文本。

因此 React Native 客户端必须复用 protocol reducer，并仅在 transport/store 外层增加 `controlPlaneId` 和 connection epoch；不得复制 provider 扫描、用 AI 状态修正实例状态，或直接连接 node-agent。

## Control Plane AI Session Contract

响应继续使用现有 `{ data: ... }` envelope；移动 transport 负责认证、取消和结构化错误，不在组件内拼 URL。

| 能力 | Method 与 path | 主要 schema/语义 |
| --- | --- | --- |
| 聚合 snapshot | `GET /api/ai-sessions` | `ControlPlaneAiSessions`；初始加载、恢复或显式刷新使用 |
| 单实例 delta | `GET /api/ai-sessions?instanceId=...&streamId=...&sinceRevision=...` | `AiSessionDeltaResponseSchema`；可能返回 `syncRequired` |
| 历史列表 | `GET /api/controlled-instances/:id/ai-sessions/history` | `AiSessionHistoryListSchema` |
| 历史详情 | `GET /api/controlled-instances/:id/ai-sessions/history/:sessionId` | `AiSessionHistoryDetailSchema` |
| Resume | `POST /api/controlled-instances/:id/ai-sessions/:sessionId/resume` | 空 strict body；`AiSessionResumeResultSchema`，支持 `resumed/already-open` |
| Create | `POST /api/controlled-instances/:id/ai-sessions` | `AiSessionCreateRefInputSchema`；稳定 `clientRequestId`，结果为 `AiSessionCreateResultSchema` |
| Send | `POST /api/controlled-instances/:id/ai-sessions/:sessionId/messages` | `AiSessionMessageRefInputSchema`；send mode、permission、references 与 attachment refs |
| Approval | `POST /api/controlled-instances/:id/ai-sessions/:sessionId/approval` | `AiSessionApprovalInputSchema`；`allow/deny/skip` |
| Interrupt | `POST /api/controlled-instances/:id/ai-sessions/:sessionId/interrupt` | 空 body，返回 `AiSessionActionResultSchema` |
| Queue snapshot | `GET /api/controlled-instances/:id/ai-sessions/:sessionId/queue` | `AiSessionQueueSchema` |
| Queue steer/retry/remove | `POST .../queue/:queueId/steer`、`POST .../retry`、`DELETE .../queue/:queueId` | 必须等待响应或权威 session/queue 恢复，不能仅本地改写 |
| Mark read | `POST /api/controlled-instances/:id/ai-sessions/:sessionId/read` | strict `{ sessionUpdatedAt }`；只更新匹配权威版本的未读状态 |
| 上传设备附件 | `POST /api/ai-session-attachments` | 绑定 `instanceId/sessionId` 的短期 upload；返回 `upload-ref` 所需 id 和 expiry |
| Runtime path 附件 | 随 Create/Send body 提交 | `source.type = runtime-path`，必须是目标 controlled instance 文件系统语义 |

当前 attachment store 为 Control Plane 进程内、默认 24 小时 TTL，并在成功 resolve 后消费 upload ref。上传失败、过期、scope 不匹配或发送结果未知必须显式呈现，设备 `file://`/`content://` URI 不得写入业务协议。

## WebSocket Contract

- 入口：同 origin `/api/events`，HTTPS 对应 WSS。
- 握手：`streams.hello`，按 `(topic, instanceId)` 广告 `streamId/latestRevision/earliestRetainedRevision`。
- 权威投影事件：`ai-session.snapshot`、`ai-session.patch`、`ai-session.removed`。
- 展示增量：`ai-session.message-delta`，身份为 `instanceId/sessionId/providerSessionId/turnId/itemId`；它不能修改列表 revision。
- 未读：`ai-session.unread.updated`，只有 `sessionUpdatedAt` 与当前 session 匹配时才能应用。
- node-agent 转发：Control Plane UI 可能收到外层 `node-agent.event.forwarded`；消费者归一化 envelope 后仍应用原始领域事件。
- 断线或 App 后台恢复：创建新 connection epoch，丢弃旧回调，验证 profile/session，snapshot-first 后再追赶新 revision；不退化为常态 HTTP 轮询。

## 现有测试基线

实现移动共享核心时至少保持以下既有验证通过：

- Protocol reducer 与 stream schema：`packages/protocol/test/session-streams.test.js`。
- Control Plane/controlled instance API、事件、恢复、附件与 unread：`test/control-plane.test.js`、`test/control-plane-ui-streams.test.js`、`test/session-ui-streams.test.js`、`test/chat.test.js`。
- Vue UI 行为：`packages/control-plane-ui/test/ai-session-*.test.js`、`session-preview-mobile-status.test.js`、`mobile-dynamic-viewport.test.js` 和 streaming markdown tests。
- 关键 UI 纯逻辑：列表排序、draft、unread、history、attachments、sub-agents、tool activity、permission mode 和 detail navigation 均已有独立测试文件；抽取共享模块时 Web 与 React Native 应使用同一事件序列做 contract test。

## 首发清单与延期边界

首发必须同时完成：

- Direct HTTPS Control Plane profile、目标自身认证、安全存储和同 origin HTTP/WSS transport；
- AI Session Inbox、Detail、create、history/resume、send、approval、interrupt、mark-read 和断线恢复；
- 完整 sub-agent 展示与 queue steer/retry/remove；
- 手机图片/普通文件 `upload-ref` 与实例已有文件 `runtime-path` 两条附件链路；
- Node/Instance 权威只读目录及到 Inbox/New Session 的稳定 id 导航。

首发明确不包含：Thandoff 账户、binding、Control Plane 目录、ticket、relay、Node/Instance 生命周期、terminal、完整文件管理、模型/环境/应用管理、trigger 和完整 settings。生产依赖和网络检查必须证明移动端没有 Thandoff 账户 SDK、relay 配置、Node credential 或 `NodeAgentTransport`。

## 待保存视觉基线

任务 1.3 需要在相同窄屏视口、主题和数据状态下保存现有 Control Plane 的 Inbox/Card/Detail/Composer/Approval 截图、DOM 语义和关键计算样式。该项必须使用可复现运行态数据单独完成，不能以代码阅读代替。
