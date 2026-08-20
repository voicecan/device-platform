# Voicecan Device Platform

[English](README.md)

Voicecan Device Platform 是一个自托管设备平台，用于连接 Voicecan 兼容设备、管理录音，并为应用提供安全的数据访问能力。它可以运行在边缘设备、私有服务器或容器化环境中，不依赖 Voicecan 账户、家庭服务、模型服务或现有业务 API。

## 你可以做什么

- **连接设备**：通过浏览器、WebSocket 或附近 Bluetooth 完成配网、认领、状态查看和设备控制。
- **管理录音**：发现录音、可靠同步文件、恢复中断传输，并保留不可变文件历史。
- **管理权限**：使用 Group 组织用户和设备，创建有范围的应用凭据，并查看管理审计记录。
- **构建应用**：通过 REST、TypeScript、Python、MCP、Webhook 或可复用的 Device Connect Web 接入自己的产品。
- **执行设备运维**：管理本地固件包、执行 OTA、查看设备状态，并通过 Admin 或 CLI 操作平台。
- **选择存储**：边缘安装使用本地文件，共享部署可连接对象存储。
- **持续运营**：使用备份、恢复、配额、投递重试、Dead Letter 检查、健康检查和指标完成日常运维。

## 主要使用入口

| 入口 | 用途 |
| --- | --- |
| Admin | Setup、用户、Group、Application、设备、录音、固件、Webhook 和运维工具 |
| Device Connect Web | 公开浏览器设备配网和连接流程 |
| REST API | 将设备、录音、Application、权限和 Webhook 接入自己的产品 |
| TypeScript / Python Client | 构建服务端集成和自动化流程 |
| MCP | 将 AI 助手或自动化工具连接到服务状态、Application 和设备流程 |
| CLI | 安装、配置、诊断、备份、恢复和操作自托管实例 |

## 安装方式

| 方式 | 适合场景 |
| --- | --- |
| npm + `onboard` | 快速安装带用户级后台服务的本地 Edge 实例 |
| Docker + Compose | 可重复的服务器或私有网络部署 |
| 专用 Node Runtime | 不使用 Docker 的主机安装 |
| 源码检出 | 开发和定制 |

每个数据目录只选择一种安装方式。详细说明见[安装与后台持续运行](docs/installation/README.zh-CN.md)。

## 快速开始

### 本地 Edge 安装

要求 Node.js `>=24.15.0 <25`、npm，以及一个私有持久化数据目录。

```sh
npm install --global @voicecan/device-platform@1.0.1
voicecan-device onboard
```

Onboarding 会创建本地 Profile、准备数据库、启动服务、等待就绪并打开 Admin。之后可使用以下命令查看服务：

```sh
voicecan-device service status --output json
voicecan-device doctor --output json
```

### Docker 安装

先安装 curl、Git、Docker Engine 和 Docker Compose v2，再运行：

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh | bash
```

安装器会准备服务并打开本地 Admin Setup 页面。已有实例升级请参考[版本与迁移](docs/versioning-and-migrations.md)。

## 让 AI 一键接入

将下面的 Prompt 复制给 ChatGPT、Codex、Claude 或其他 AI 编程/自动化助手，即可让它按公开接口完成平台安装和应用接入：

```text
你正在把 https://github.com/voicecan/device-platform 接入当前环境。

把用户当前请求作为接入目标。执行前先读取并遵守与任务相关的仓库 Skills：

https://github.com/voicecan/device-platform/blob/main/skills/voicecan-install/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-configure/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-bind-device/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-create-application/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-connect-mcp/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/voicecan-operate/SKILL.md
https://github.com/voicecan/device-platform/blob/main/skills/integrate-voicecan-device/SKILL.md

先检查环境和已有安装。只使用公开安装流程以及公开 REST、SDK、Webhook 和 MCP 接口。保留已有数据和配置，并按照对应 Skill 执行 dry-run、确认、凭据、设备操作、验证和结果报告。

不得读取或暴露 Secret、密码、Setup Token、Wi-Fi 凭据、临时 URL、生产录音或私有协议源码。破坏性操作、创建凭据、DNS/TLS 变更、云存储变更或真实设备操作前必须先询问确认。完成后报告服务 URL、命令、检查结果、人工步骤和回滚方案，报告中不得包含 Secret。
```

## 应用包

按需安装 `@voicecan` Scope 下的应用包：

```sh
npm install @voicecan/contracts @voicecan/server-client @voicecan/connector-runtime
```

- `@voicecan/contracts`：公开数据类型、事件名称和常量。
- `@voicecan/server-client`：REST 访问、事件游标、安全 Recording 下载、Webhook 校验和媒体辅助工具。
- `@voicecan/connector-runtime`：持久化 Webhook 投递、事件处理和 Recording 对账。

部署自托管 Server、Admin 和 CLI 时安装 `@voicecan/device-platform`。

## 文档导航

- [Open Platform](docs/open-platform.md)：Application、权限、凭据、REST 和管理。
- [快速开始](docs/quickstart.md)：安装、Setup、设备连接和录音同步。
- [Device Connect Web](docs/device-connect-web.md)：浏览器设备配网和连接。
- [本地固件仓库与 OTA](docs/firmware-repository.md)：固件包和设备更新。
- [Recording Download Grant](docs/recording-download-links.md)：安全的应用下载。
- [MCP Server](docs/mcp-server.md)：连接 MCP Client 和 AI 工具。
- [运维手册](docs/operations-runbook.md)：部署、备份、恢复和监控。
- [安全模型](docs/security.md)：认证、授权、存储和 Webhook 安全。

## 社区与项目信息

- [参与贡献](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [许可证](LICENSE)
- [第三方声明](NOTICE)
