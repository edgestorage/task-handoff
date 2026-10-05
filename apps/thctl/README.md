# thctl

`@task-handoff/thctl` 是控制面板的命令行客户端：连接一个或多个远程 control-plane，复用 Web 登录完成授权，并对脚本和 AI agent 暴露稳定的机器可读契约。安装、授权、命令面与服务端最低版本的完整说明见 [`docs/control-plane-cli.md`](../../docs/control-plane-cli.md)。

## 使用

```bash
npm install -g @task-handoff/thctl

# 首次连接：固定 control-plane 身份指纹
thctl profile add https://control.example.com

# 浏览器授权（默认）；无浏览器时用 --device
thctl login
thctl login --device

thctl whoami
thctl instance list
thctl instance show <instanceId>
thctl instance create --config ./instance.json --start
thctl instance delete <instanceId> --volumes --yes
thctl instance restart <instanceId> --yes
thctl ai-session list --instance <instanceId> --json
thctl ai-session show <instanceId> <sessionId>
thctl ai-session send <instanceId> <sessionId> "继续" --yes
thctl ai-session mentions <instanceId> <sessionId> --kind skill
thctl ai-session send <instanceId> <sessionId> "看下附件" --attachment <attachmentId> --yes
thctl ai-session attachment <instanceId> <sessionId> <messageId> <attachmentId> --output ./downloads
thctl ai-session story <instanceId> <sessionId> --story <storyId> --yes
thctl ai-session model <instanceId> <sessionId> --entity <modelEntityId> --name <modelName> --yes
thctl ai-session workspace <instanceId>
thctl ai-session checkout <instanceId> --branch feature/demo --yes
thctl ai-session transcript <instanceId> <sessionId> --tail 200
thctl ai-session story-content <instanceId> <sessionId> --json
thctl ai-session story-content read <instanceId> <sessionId> --path docs/design.md
thctl instance update <instanceId> --config ./instance-settings.json
thctl instance app list <instanceId>
thctl instance app install <instanceId> <appId> --wait
thctl instance app catalog <instanceId> --json
thctl app-profile list <instanceId> <appId>
thctl app-session list --json
thctl app-session logs <instanceId> <appSessionId> --json
thctl app-session screenshot <instanceId> <appSessionId> --out ./session.png
thctl app-session access <instanceId> <appSessionId> --json | jq -r .token | thctl app-session revoke-access <instanceId> <appSessionId> --token-stdin --yes
thctl node list --json
thctl story list --json
thctl trigger list --json
thctl model list --json
thctl user sessions <userId> --json
thctl events --topic ai.sessions --topic instances
thctl events --instance <instanceId> --json
thctl skill status
thctl skill update --yes
thctl schema --format json
```

- 全局参数：`--profile <label>`、`--json`、`--yes`、`--dry-run`、`--config <file>`、`--token-stdin`、`--no-update-check`。
- 密钥只从 `--config <file>` 或 `--token-stdin` 进入，位置参数与普通选项不接受 secret；`--dry-run`、stderr 与错误详情中的 secret 统一脱敏为 `***`。
- 写命令默认要求交互确认；非 TTY 环境必须显式 `--yes`，`--dry-run` 只打印将要发送的请求。
- 数据写 stdout、诊断写 stderr；`--json` 输出与服务端 wire 模型的字段名一致。
- 退出码：0 成功、2 用法错误、3 未实现、4 需要确认、5 未认证、6 无权限、7 未找到、8 冲突、9 限流、10 网络、11 协议、12 服务端、13 身份、14 能力缺失、15 取消。

## 配置与凭证

- 配置目录默认 `~/.config/task-handoff/cli`（遵循 `XDG_CONFIG_HOME`），可用 `TASK_HANDOFF_CLI_CONFIG_DIR` 覆盖。
- `profiles.json` 只保存 origin、`controlPlaneId`、指纹、协议版本与 capability 快照，不含任何密钥。
- session token 保存在独立的 `credentials.json`（0600，目录 0700）；后续可替换为系统 keychain 而不影响上层。
- profile 选择优先级：`--profile` > `TASK_HANDOFF_CLI_PROFILE` > `thctl profile use` 设置的默认 profile；完全没有 profile 时会先尝试检测本机运行的控制面板。
- 本机桌面 control-plane（`--auth-mode disabled`）无需先 `profile add`：CLI 读取用户级运行态锁验证进程与身份后自动写入受管的 `local` profile，并签发可审计的本地信任会话；远程或已启用用户管理的控制面板仍走 Web/device 授权。
- 身份变化不会被自动接受，必须用 `thctl profile trust <label> --yes` 显式重新信任。

## 命令面

已实现：

- `profile add|list|use|show|remove|trust`、`login [--device]`、`logout`、`whoami`、`schema`；
- `instance list|show|create|delete|start|stop|restart|rename|update`、`instance app list|install|uninstall|job|catalog|catalog custom|catalog custom update`；
- `ai-session list|show|history|turns|turn|timeline|turn-timeline|create|send|interrupt|approval|resume|read|rename|fork|close|story|open-app|open-terminal|command|mentions|mentions files|upload|attachment|model|reasoning|workspace|checkout|transcript|story-content|story-content read`、`ai-session queue list|steer|retry|remove|edit|reorder`；
- `app-session list|show|start|stop|rename|access|revoke-access|restart|logs|screenshot`、`app-profile list|create|rename|set-default|remove`；
- `node list|show|rename|create|remove|check|sync-local`、`node folders list|tree|add|update|remove`、`node runtimes list|create|update|remove|check`、`node docker images`、`node image-options`、`node settings external-listener show|set`、`node settings model-relay show|set`、`node updates jobs|check|apply`、`node pairing invite`、`node pairings list|remove`、`node connections list|create|remove`、`node-join invite|status|complete`；
- `story list|show|create|update|archive|restore|remove`、`story document update|remove|reorder`、`story automation list|show|create|update|remove|enable|disable|run|runs`；
- `trigger list|show|create|update|remove|run|bind|unbind|apply`；
- `model list|show|create|copy|discover|test|reorder|update|sync|merge|remove`、`model node list|create|update|remove|discover|test`；
- `project list|show|create|update|remove`、`image list|show|create|update|remove|options`、`market catalog|refresh`、`env-template list|show|create|remove`；
- `git-credential list|show|create|update|remove`、`git-credential assignments list|assign|unassign`、`chat status`、`chat bridges list|create|update|start|stop|remove`、`chat sessions list|show`、`mobile-session list|revoke`；
- `control-plane status|settings show|settings update|diagnostic-logs export`、`cloud show|challenge|remote-access|disconnect`、`proxy invites list|create|remove`、`proxy bindings list|remove`、`proxy diagnostics`、`proxy pending-claims list|resume|remove`；
- `user list|show|sessions|session-revoke|create|update|access|password-reset`、`user role list|create|update|remove`、`user permission list`、`user identity-provider list|create|update|remove`、`user external-identity list|approve|reject`；
- `skill status|install|update`：安装/升级唯一发布的 `taskhandoff` Agent Skill，属于软件本身，默认装到用户级 `~/.agents/skills`（`--scope project` 才装到项目 `.agents/skills`），`--dir` 指定自定义 skills 根目录；
- `events [--topic <topic>]... [--instance <instanceId>]`：订阅 `/api/events`，每个事件输出一行 JSON（JSON Lines）；断线按连接 epoch 重连并重新订阅，握手前不输出，重放事件按 id 去重，不退化为轮询。

命令面共 236 个叶子，`thctl schema` 导出的契约是唯一来源。

### Skill 与升级检查

- `thctl skill install|update` 从文档站索引（默认 `https://docs.thandoff.com/.well-known/skills/index.json`，可用 `TASK_HANDOFF_SKILLS_INDEX_URL` 覆盖）下载 skill，按索引里的 sha256 校验每个文件，原子替换目录，并写入 `.thandoff-skill.json` 记录版本、来源与每个文件的摘要；本地修改过的副本在 `skill update` 时报冲突（退出码 8），需要 `--force` 才替换。
- 是否需要更新按**内容**判断：把索引 `integrity` 里的文件摘要与本机 provenance 的摘要比对，不同就更新（`status` 显示 `update-available`）。所以版本号只是标签，可以是 `<上次改动日期>-<内容哈希>` 这类任意样式，不需要单调递增或可比大小；缺少任一侧摘要时（老索引、手工安装且没有 provenance 的副本）退回版本比较。
- 索引可声明所需的 `thctl` semver 范围；版本过旧时安装/更新直接以退出码 14 拒绝，`thctl skill status` 显示 `cli-too-old`。旧的 `task-handoff`/`task-handoff-nodes` 目录会被识别为 `legacy-name` 并提示迁移。
- 每次 CLI 调用最多每 24 小时派生一次后台检查（`thctl __update-check`），把最新 dist-tag 版本与 skill 索引的内容指纹写进 CLI 配置目录的 `update-check.json`；下一次交互运行时在 stderr 提示 `thctl x → y is available: npm install -g @task-handoff/thctl@latest` 或 `skill taskhandoff x → y is available: thctl skill update`。
- 提示只出现在交互式 TTY 且非 `--json` 的运行；`--no-update-check` 或 `TASK_HANDOFF_CLI_UPDATE_CHECK=0` 完全关闭，`TASK_HANDOFF_CLI_UPDATE_CHECK=1` 强制提示，`TASK_HANDOFF_CLI_UPDATE_CHECK_INTERVAL`（秒）覆盖 24 小时窗口，`TASK_HANDOFF_CLI_REGISTRY` 覆盖 npm registry。检查失败一小时后重试，绝不影响当前命令的输出与退出码。

### 能力门控

- 节点命令（`node *`、`node-join *`）按目标节点的结构化 capability 文档（`GET /api/nodes/:id` 的 `capabilities.agent.capabilities`）查询，统一走 `supportsNode*`；
- 控制面板管理命令（`user *`、`control-plane *`、`cloud *`、`proxy *`、`mobile-session *`）按身份文档里的 `supportsControlPlane*` 查询；
- 旧服务端缺路由返回无信封的 404/405/501 时归一为 `CLI_CAPABILITY_MISSING`（退出码 14），只关闭该命令域，登录、`whoami` 与其他命令域不受影响；协议版本不匹配只产生 warning。

`instance logs`（阶段 C 预留）仍是未实现契约，调用会以未实现错误（退出码 3）退出，不会发送业务请求。`thctl schema` 是全部契约的唯一来源，`outputMode: json-lines` 标记流式命令。`story` 系列的 `--node` 在省略时按权威目录解析 ownerNodeId，不做本地缓存。

`instance create --config` 直接提交 `POST /api/controlled-instances` 的 wire body（`InstanceCreateInputSchema`，见 `@task-handoff/protocol/control-plane`）；`--name`/`--node`/`--start` 只覆盖同名字段。服务端 `start` 默认 `false`，Docker 实例的镜像 provisioning 与容器启动是异步的，创建/启动请求返回后请用 `thctl instance show <instanceId>` 观察状态。`instance delete --volumes` 删除托管卷且不可恢复；不传 `--volumes` 时卷保留。
