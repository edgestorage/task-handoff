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

> Task Handoff 是开源、自托管的 AI 工作空间控制平面。官方云平台补充账号与加密中转能力，见 `ee/cloud-platform/README.md`。

## 核心能力

- **多节点管理**：接入本机或远程节点，集中查看节点、运行资源和受控实例状态。
- **受控工作空间**：创建、启动、停止和恢复隔离的工作空间实例；当前以 Docker 为主要运行时。
- **镜像市场与自定义镜像**：内置 Market 镜像只读、用户 Custom Image 独立管理，创建实例时通过统一选项选择。
- **环境模板**：把 Docker 实例中安装的工具和容器配置保存为节点本地的可复用环境，再与任意 Git 项目或本地目录工作空间组合。
- **AI 会话中心**：统一查看和控制实例中的 AI 会话，通过 WebSocket 实时同步状态。
- **仓库协作**：在会话中查看文件、变更、分支和 worktree，并提供保守的远程交付能力。
- **托管 Git 凭证**：按 remote scope 管理 HTTPS token 或 pinned SSH key，可仅用于首次 provisioning，也可保留给 Agent、Terminal、App 和 Repository 的后续 Git 命令。
- **聊天入口整合**：通过适配器接入 Telegram、钉钉、微信和飞书/Lark，将消息、审批和操作路由到指定实例。
- **应用管理**：通过可信内置目录在目标实例中安装、卸载和运行应用。
- **移动端客户端**：iOS 或 Android 设备可直接连接用户管理的 Control Plane，访问 AI 会话、实例操作、应用和终端。
- **移动、桌面与服务器部署**：可作为移动端或桌面应用使用，也可在 Debian/Ubuntu 服务器上部署为 systemd 服务。
- **中英文界面**：控制平面支持简体中文和英文，可跟随浏览器语言自动切换。

## 系统架构

```text
浏览器 / 桌面端 / 移动端 / 聊天平台
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

系统由三个运行层组成：

- **Control Plane（控制平面）**：提供 Web/API 管理入口，维护节点清单、实例看板、聊天网关和跨实例 AI 会话视图。
- **Node Agent（节点代理）**：运行在每台受管机器上，管理本机配置、运行时资源、目录清单和受控实例生命周期。实例启动、恢复和停止不依赖控制平面持续在线。
- **Controlled Instance（受控实例）**：承载具体工作空间、应用、AI 会话、触发器和元数据。它可以独立运行；在受管部署中，其生命周期与访问由 Node Agent 负责。

聊天与 AI Session 状态构成一条跨层链路：聊天凭据、入口绑定、命令解析和路由由 Control Plane 统一管理，会话状态则以目标实例中的 AI Session 为唯一来源。

Docker 是主要的隔离运行时，支持一个节点运行多个实例。受支持的非 Windows 节点也内置 Local Runtime，同一宿主用户只能运行一个本机受控实例。整体模型仍可通过运行时能力和适配器扩展到 Kubernetes，无需复制 UI 流程。

### 环境模板

环境模板是 Node Agent 通过 `docker commit` 从现有实例创建的节点本地 Docker 镜像。Registry 镜像与环境模板在实例创建流程中是同级环境来源；工作空间选择保持独立，因此两者都可以与 Git 项目或本地目录工作空间组合。

模板只捕获容器可写层，例如已安装的系统包和工具。它不包含 `/workspace`、`/data`、`/home/agent`、其他 bind mount 或 volume，也不包含内存、进程和网络状态。派生实例始终获得新的身份、注册令牌、端口和托管卷。提交期间 Node Agent 会短暂停止源容器；如果 Docker Config 中包含实例私有凭据，则拒绝创建模板。

每个 Docker 实例都有 `/data` 和 `/home/agent` 托管卷；Git 工作空间另有 `/workspace` 托管卷，本地目录则使用外部 bind mount。删除实例时默认删除全部托管数据；取消该选项会保留并报告所有托管卷名称，但这些卷不会自动挂载到其他实例。

源节点同时拥有模板记录和对应 Docker 镜像，因此模板只有在该节点就绪时才能使用。删除模板会移除内部模板标签；只要仍有派生实例引用它，基于内容地址的内部租约就会保留镜像，最后一个引用删除后才执行垃圾回收。

## 快速开始

### 环境要求

- Node.js `>= 24.15.0 < 25`
- pnpm `9.15.3`
- Docker（使用 Docker Runtime、构建容器镜像或运行 standalone Compose 配置时需要）

### 本地开发

```sh
pnpm install
pnpm run build:all
pnpm cli help
```

分别在两个终端启动 Control Plane API 和开发版 UI。关闭认证仅适用于监听本机回环地址的开发环境：

```sh
pnpm cli control-plane --auth-mode disabled
pnpm run control-plane-ui:dev
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

如需运行 standalone Browser profile 受控实例，而不是 Control Plane 开发环境：

```sh
docker compose up -d --build
```

默认把当前目录挂载为容器内的 `/workspace`；可通过 `TASK_HANDOFF_WORKSPACE_HOST` 指定其他宿主机目录。该 Compose 服务是独立受控实例，不包含 Control Plane 和 Node Agent 部署。

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

远程机器只需安装 Node Agent。先在 Control Plane 生成一次性加入令牌，并优先复制界面提供的完整安装命令；其中的包版本会根据当前 Control Plane 发布版本生成。等价形式如下：

```sh
curl -fsSL https://CONTROL_PLANE_HOST/install-node-agent.sh | sudo sh -s -- \
  --control-plane https://CONTROL_PLANE_HOST \
  --join-token JOIN_TOKEN \
  --npm-package @task-handoff/node-agent \
  --controlled-instance-package @task-handoff/controlled-instance \
  --version RELEASE_VERSION
```

请把 `RELEASE_VERSION` 替换为 Control Plane 的运行时包版本，确保 Node Agent 与受控实例运行时使用同一发布版本。

也可以直接在已安装 Node Agent 的机器上生成一次性邀请令牌：

```sh
sudo task-handoff-node-agent invite --ipc-path /run/task-handoff/node-agent.sock
```

使用 `--json` 可获得适合自动化处理的输出。远程 TCP 接入仍需邀请令牌和配对后的 HMAC 认证。

卸载独立安装的 Node Agent：

```sh
sudo task-handoff-node-agent uninstall
```

该命令会移除 systemd 服务和运行时包，最后询问是否删除 Node Agent 数据目录，默认不删除。非交互执行可显式传入 `--keep-data` 或 `--delete-data`。受管 Docker volume 不会被连带删除。

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
apps/mobile/                      Expo iOS 与 Android 客户端
packages/control-plane/           控制平面、Node Agent 与聊天网关
packages/control-plane-client/    Web 与移动端共享的 Control Plane API 和实时客户端
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

### 运行时与服务器包

推送 `v1.2.3` 形式的语义化版本标签时，工作流会构建受控实例运行时 artifact，发布 `@task-handoff/control-plane`、`@task-handoff/node-agent`、`@task-handoff/controlled-instance` 和 `@task-handoff/server`，并把安装脚本及不可变 artifact 附加到 GitHub Release。`alpha`、`beta` 版本使用对应的 npm dist-tag，稳定版本更新 `latest`。

### Docker 镜像

Docker 工作流使用独立的 `docker-vX.Y.Z` tag 发布，并构建、冒烟测试五种镜像配置：

| 镜像 | Profile 能力 |
| --- | --- |
| `task-handoff-controlled-codex` | Terminal、Codex |
| `task-handoff-controlled-opencode` | Terminal、OpenCode |
| `task-handoff-controlled-ai` | Terminal、Codex、Claude |
| `task-handoff-controlled-webcap` | GUI Terminal、Browser、WebCap、Codex、Claude |
| `task-handoff-controlled-browser` | GUI Terminal、Browser、VS Code Web、Codex、Claude；不包含 WebCap |

五者都是 Node Agent 受管 Docker 实例使用的基础镜像，本身不包含
controlled-instance runtime。容器启动后，Node Agent 会把目标 runtime
artifact 下载、校验并安装到实例 runtime volume。每次发布都会生成不可变的
`docker-sha-<commit>` 标签。推送 `docker-v1.2.3` 形式的 Docker 版本标签时，
对应镜像会提升为该标签；稳定 Docker 版本同时更新 `latest`。

### 桌面应用

推送语义化版本标签会构建 macOS arm64/x64、Windows x64 和 Linux x64 安装包，并发布到 GitHub Release。带 `alpha` 或 `beta` 后缀的版本会标记为预发布版本。macOS 构建会执行签名、公证、票据装订和 Gatekeeper 校验；Windows 代码签名暂未启用。

关闭桌面控制面板窗口后，TaskHandoff 会继续在系统托盘运行。托盘会显示当前 Control Plane 和 Node Agent 服务状态，并可在不重启服务的情况下恢复原窗口。只有从托盘或平台应用菜单选择“退出 TaskHandoff”才会停止桌面后台服务。Node Agent 优雅退出时会停止 Local Runtime controlled instance，并在下次启动时恢复；Docker Runtime controlled instance 保持运行，Node Agent 恢复后会重新发现并接管。

### 移动端应用

推送严格采用 `mobile-vX.Y.Z` 格式的稳定版本标签时，工作流会执行移动端发布检查，并分别启动 Android 和 iOS 发布任务。Android 生成 APK 并附加到对应 GitHub Release；iOS 通过 `ios-production` 环境审批后构建并提交到 App Store Connect/TestFlight，最终 App Store 审核仍需人工操作。该工作流不会把 Android 构建提交到 Google Play。

移动端能力边界与开发命令见 [`apps/mobile/README.md`](apps/mobile/README.md)，凭据、首次构建和发布操作见 [`apps/mobile/RELEASE.md`](apps/mobile/RELEASE.md)。

## 许可证

TaskHandoff 基于 [Apache License 2.0](LICENSE) 开源，第三方归属信息见 [NOTICE](NOTICE)。
