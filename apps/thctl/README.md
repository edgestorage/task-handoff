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
thctl app-session list --json
thctl node list --json
thctl story list --json
thctl trigger list --json
thctl model list --json
thctl user sessions <userId> --json
thctl events --topic ai.sessions --topic instances
thctl events --instance <instanceId> --json
thctl schema --format json
```

- 全局参数：`--profile <label>`、`--json`、`--yes`、`--dry-run`。
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
- `instance list|show|create|delete|start|stop|restart|rename`；
- `ai-session list|show|history|turns|turn|timeline|turn-timeline|create|send|interrupt|approval|resume|read|rename|fork|close|model|reasoning`、`ai-session queue list|steer|retry|remove|edit|reorder`；
- `app-session list|show|start|stop|rename|access|restart`、`node list|show|rename`；
- `story list|show|create|update|archive|restore|remove`、`story document update|remove|reorder`、`story automation list|show|create|update|remove|enable|disable|run|runs`；
- `trigger list|show|create|update|remove|run|bind|unbind|apply`、`model list|show`、`user list|show|sessions|session-revoke`；
- `events [--topic <topic>]... [--instance <instanceId>]`：订阅 `/api/events`，每个事件输出一行 JSON（JSON Lines）；断线按连接 epoch 重连并重新订阅，握手前不输出，重放事件按 id 去重，不退化为轮询。

`instance logs`（阶段 C 预留）仍是未实现契约，调用会以未实现错误（退出码 3）退出，不会发送业务请求。`thctl schema` 是全部契约的唯一来源，`outputMode: json-lines` 标记流式命令。`story` 系列的 `--node` 在省略时按权威目录解析 ownerNodeId，不做本地缓存。

`instance create --config` 直接提交 `POST /api/controlled-instances` 的 wire body（`InstanceCreateInputSchema`，见 `@task-handoff/protocol/control-plane`）；`--name`/`--node`/`--start` 只覆盖同名字段。服务端 `start` 默认 `false`，Docker 实例的镜像 provisioning 与容器启动是异步的，创建/启动请求返回后请用 `thctl instance show <instanceId>` 观察状态。`instance delete --volumes` 删除托管卷且不可恢复；不传 `--volumes` 时卷保留。
