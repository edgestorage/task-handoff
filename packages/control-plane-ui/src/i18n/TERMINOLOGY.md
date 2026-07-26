# Control-plane localization terminology

翻译使用产品语义，不改写协议字段、代码标识符或用户内容。首期核心术语统一如下：

| English | 简体中文 | 说明 |
| --- | --- | --- |
| control plane | 控制面板 | 指 TaskHandoff 管理面；协议名和代码符号保留 `control-plane` |
| node | 节点 | 运行 node-agent 并承载实例的主机 |
| node agent | 节点代理 | 产品进程名 `task-handoff-node-agent` 保持原文 |
| instance | 实例 | controlled instance 的管理对象 |
| controlled instance | 受管实例 | 强调被 node-agent/control-plane 管理时使用 |
| session | 会话 | AI session 统一译为 AI 会话 |
| runtime | 运行时 | Docker、localhost 等实例执行环境 |
| repository | 仓库 | Git 仓库及其工作区 |
| workspace | 工作区 | 目标实例文件系统中的工作目录 |
| trigger | 触发器 | 定时或事件驱动的自动执行配置 |
| image | 镜像 | 容器镜像；普通图片按上下文译为图片 |
| approval | 审批 | AI 会话需要用户确认的动作 |

翻译 key 使用稳定业务语义（如 `instances.actions.restart`），不得使用英文原句作为 key。终端输出、日志、AI 消息、仓库内容、路径、协议值和用户输入保持原样。
