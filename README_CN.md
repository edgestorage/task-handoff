<div align="center">
  <img src="build/icon.png" alt="TaskHandoff Logo" width="144" height="144">
  <h1>TaskHandoff</h1>
  <p><strong>面向本地与远程 AI 工作空间的统一运行、管理与协作控制面板</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24">
    <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3">
    <img src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white" alt="TypeScript 6">
    <img src="https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white" alt="Docker Ready">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-D22128" alt="Apache-2.0 License"></a>
  </p>
  <p><a href="README.md">English</a> | <strong>简体中文</strong></p>
</div>

---

TaskHandoff 用于集中运行和监管 Codex 等 AI 开发工作。它把分散在不同机器、工作空间和聊天入口中的 AI 会话统一到一个控制面板中，并负责节点接入、实例生命周期、会话管理、应用运行和消息路由。

> 项目正在从独立的任务交接 CLI 演进为完整的 AI 工作空间控制平面，部分能力和接口仍在持续调整。

## 核心能力

- **多节点管理**：接入本机或远程节点，集中查看节点、运行资源和受控实例状态。
- **受控工作空间**：创建、启动、停止和恢复隔离的工作空间实例；当前以 Docker 为主要运行时。
- **镜像市场与自定义镜像**：内置 Market 镜像只读、用户 Custom Image 独立管理，创建实例时通过统一选项选择。
- **AI 会话中心**：统一查看和控制实例中的 AI 会话，通过 WebSocket 实时同步状态。
- **仓库协作**：在会话中查看文件、变更、分支和 worktree，并提供保守的远程交付能力。
- **聊天入口整合**：通过适配器接入 Telegram、钉钉、微信等平台，将消息、审批和操作路由到指定实例。
- **应用管理**：通过可信内置目录在目标实例中安装、卸载和运行应用。
- **桌面与服务器部署**：既可作为桌面应用使用，也可在 Debian/Ubuntu 服务器上部署为 systemd 服务。
- **中英文界面**：控制平面支持简体中文和英文，可跟随浏览器语言自动切换。

## 系统架构

```text
浏览器 / 桌面端 / 聊天平台
             │
             ▼
       Control Plane
   管理界面、API、消息网关
             │
             ▼
         Node Agent
  节点资源与实例生命周期管理
             │
             ▼
    Controlled Instance
 工作空间、应用与 AI 会话运行时
```

系统由四类协作组件组成：

- **Control Plane（控制平面）**：提供 Web/API 管理入口，维护节点清单、实例看板、聊天网关和跨实例 AI 会话视图。
- **Node Agent（节点代理）**：运行在每台受管机器上，管理本机配置、运行时资源、目录清单和受控实例生命周期。实例启动、恢复和停止不依赖控制平面持续在线。
- **Controlled Instance（受控实例）**：承载具体工作空间、应用、AI 会话、触发器和元数据。当前通常运行在 Docker 中，并由 Node Agent 负责代理访问。
- **Chat Gateway 与 AI Session**：聊天凭据、入口绑定、命令解析和路由由控制平面统一管理；会话状态以目标实例中的 AI Session 为唯一来源。

Docker 是当前主要运行时。整体模型通过运行时能力与适配器扩展，便于后续接入 Kubernetes 或本机运行时，而无需为不同运行环境复制 UI 流程。

## 快速开始

### 环境要求

- Node.js `>= 24.15.0 < 25`
- pnpm `9.15.3`
- Docker（运行完整本地环境或受控实例时需要）

### 本地开发

```sh
pnpm install
pnpm run build:all
pnpm cli help
```

常用开发命令：

```sh
# 启动控制平面前端
pnpm run control-plane-ui:dev

# 类型检查与构建
pnpm run typecheck
pnpm run web:typecheck
pnpm run build:all

# 运行测试
pnpm test

# 检查 npm 发布内容
pnpm run pack:dry
```

启动完整 Docker 测试环境：

```sh
pnpm run docker:up:all
```

默认会把当前目录挂载为容器内的 `/workspace`。如需指定其他宿主机目录，可设置 `TASK_HANDOFF_WORKSPACE_HOST`：

```sh
TASK_HANDOFF_WORKSPACE_HOST=/path/to/workspace pnpm run docker:up:all
```

## 服务器部署

服务器部署会把 Control Plane 和本机 Node Agent 安装为两个相互独立的 systemd 服务。控制平面可以单独停止或重启，不会终止已由 Node Agent 托管的实例。

### 一键安装

在使用 systemd 的 Debian 或 Ubuntu 服务器上，以 root 权限运行最新稳定版安装脚本：

```sh
curl -fsSL https://github.com/edgestorage/task-handoff/releases/latest/download/install-server.sh | sudo sh
```

脚本会检查运行环境，按需安装 Node.js 24 和 Docker，通过 npm 安装最新稳定版 `@task-handoff/server`，然后创建并启动 Control Plane 与 Node Agent 两个 systemd 服务。默认控制平面监听 `8081` 端口并启用密码认证；可通过安装参数修改端口、认证模式、发布渠道等设置。

### 已具备 Node.js 和 Docker

```sh
sudo npm install -g @task-handoff/server@latest
sudo task-handoff install
```

服务管理与更新：

```sh
sudo task-handoff start
sudo task-handoff stop
sudo task-handoff restart

task-handoff check
sudo task-handoff update
```

安装后会创建：

```text
task-handoff-node-agent.service
task-handoff-control-plane.service
```

安装脚本及其支持的参数以仓库中的 [`scripts/install-server.sh`](scripts/install-server.sh) 为准。

## 接入远程节点

远程机器只需安装 Node Agent。先在控制平面生成一次性加入令牌，然后在目标节点执行：

```sh
curl -fsSL https://CONTROL_PLANE_HOST/install-node-agent.sh | sudo sh -s -- \
  --control-plane https://CONTROL_PLANE_HOST \
  --join-token JOIN_TOKEN \
  --npm-package @task-handoff/node-agent \
  --controlled-instance-package @task-handoff/controlled-instance \
  --version 1.0.0
```

也可以直接在已安装 Node Agent 的机器上生成一次性邀请令牌：

```sh
sudo task-handoff-node-agent invite --ipc-path /run/task-handoff/node-agent.sock
```

使用 `--json` 可获得适合自动化处理的输出。远程 TCP 接入仍需邀请令牌和配对后的 HMAC 认证。

## CLI

`@task-handoff/server` 提供统一的 `task-handoff` 命令：

```sh
task-handoff control-plane
task-handoff node-agent
task-handoff node-agent-invite
task-handoff web
task-handoff help
```

开发环境中使用 `pnpm cli help`。聊天适配器、入口绑定、AI 会话消息、队列和审批均由控制平面管理。

## 界面语言

控制平面支持英文（`en-US`）和简体中文（`zh-CN`）。在“设置 → 外观 → 语言”中可选择跟随系统、English 或简体中文，切换后无需重新加载控制平面数据。

语言偏好仅保存在当前浏览器的 `localStorage` 中，不会写入服务器或同步到其他浏览器。终端输出、日志、AI 消息和仓库内容等用户或服务提供方数据不会被翻译。

## 项目结构

```text
apps/cli/                         CLI 入口
apps/desktop-shell/               Electron 桌面外壳
packages/control-plane/           控制平面、Node Agent 与聊天网关
packages/control-plane-ui/        控制平面 Vue UI
packages/controlled-instance/     受控实例 HTTP/WebSocket API
packages/controlled-instance-ui/  受控实例 Vue UI（已冻结功能演进）
packages/ai-session-runtime/      AI 会话运行时
packages/app-runtime/             托管应用运行时与应用目录
packages/protocol/                跨组件协议和数据模型
packages/core/                    公共能力、诊断与持久化
packages/web-theme/               Web 主题与 Markdown 展示能力
scripts/                          安装、构建和运行脚本
```

## 发布说明

### Docker 镜像

每次推送到 `main` 都会构建并冒烟测试三种累积镜像：

- `task-handoff-controlled-codex`
- `task-handoff-controlled-ai`
- `task-handoff-controlled-browser`

三者使用相同的不可变 `sha-<commit>` 标签。推送 `v1.2.3` 形式的语义化版本标签时，对应镜像会提升为该版本；稳定版本同时更新 `latest`。

### 桌面应用

推送语义化版本标签会构建 macOS arm64/x64、Windows x64 和 Linux x64 安装包，并发布到 GitHub Release。带 `alpha` 或 `beta` 后缀的版本会标记为预发布版本。macOS 构建会执行签名、公证、票据装订和 Gatekeeper 校验；Windows 代码签名暂未启用。

## 许可证

TaskHandoff 基于 [Apache License 2.0](LICENSE) 开源，第三方归属信息见 [NOTICE](NOTICE)。
