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
- profile 选择优先级：`--profile` > `TASK_HANDOFF_CLI_PROFILE` > `thctl profile use` 设置的默认 profile。
- 身份变化不会被自动接受，必须用 `thctl profile trust <label> --yes` 显式重新信任。

## 命令面

已实现：

- `profile add|list|use|show|remove|trust`、`login [--device]`、`logout`、`whoami`、`schema`；
- `instance list|show|start|stop|restart`；
- `ai-session list|show|history|create|send|interrupt|approval|resume|read`、`ai-session queue list|steer|retry|remove`；
- `app-session list|show|start|stop`、`node list|show|rename`；
- `story list|show|create|update|archive|restore|remove`、`story document update|remove|reorder`、`story automation list|show|enable|disable|run|runs`；
- `trigger list|show|create|update|remove|run`、`model list|show`、`user list|show|sessions|session-revoke`；
- `events [--topic <topic>]... [--instance <instanceId>]`：订阅 `/api/events`，每个事件输出一行 JSON（JSON Lines）；断线按连接 epoch 重连并重新订阅，握手前不输出，重放事件按 id 去重，不退化为轮询。

`instance logs`（阶段 C 预留）仍是未实现契约，调用会以未实现错误（退出码 3）退出，不会发送业务请求。`thctl schema` 是全部契约的唯一来源，`outputMode: json-lines` 标记流式命令。`story` 系列的 `--node` 在省略时按权威目录解析 ownerNodeId，不做本地缓存。
