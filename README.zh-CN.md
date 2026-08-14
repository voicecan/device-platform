# Voicecan Device Platform

[English](README.md)

这是一个独立的设备连接与不可变录音文件同步平台公开源码仓库，不依赖 Voicecan 账户、家庭、会员、模型服务或现有业务 API。

线协议实现仅以经过审查和校验的 `@voicecan/device-core` 运行时制品提供，并已提交在 `vendor/` 下。普通的 `npm install` 会在本地解析该依赖，无需检出其他源码仓库。详见[协议运行时依赖边界](docs/repository-boundary.md)。

## 已实现的预览版能力

- Node.js 24/TypeScript monorepo，以及显式执行的 SQLite 迁移。
- SQLite 访问隔离在 Worker 中；HTTP/WSS 事件循环不执行同步数据库调用。
- 仅限所有者使用的一次性 Setup Token、Argon2id 密码、HttpOnly Session、CSRF、本地用户、每位用户一个活动 Group、Group API Token 和审计记录。
- 使用随机 32 字节凭据、HMAC 校验器、AES-256-GCM 信封加密、凭据 Epoch 和带认证的 WSS 连接隔离实现设备认领。
- 按 Group 隔离的设备、文件、事件、命令、配网和转移 API；文件与事件访问权限始终从设备当前 Group 派生。
- 面向应用的 Open Platform：REST、stdio MCP、受 OAuth 保护的远程 MCP 和 Webhook 共用一套 Permission Catalog，并提供完整的凭据、协作者、配额、用量、调用日志和安全告警控制面。
- Recording API 只返回元数据或一次性临时 URL。S3 交付会重定向到有效期极短的预签名 GET；本地交付隔离在专用 Download Grant 网关后，并可通过 `external_object_only` 禁用。
- 流式本地上传 Ticket，包含精确长度校验、SHA-256、fsync、临时文件、原子重命名和不可变最终 Locator。
- `file.synced` Outbox 与带签名的至少一次 Webhook 交付，并包含所有权 Epoch 校验和 SSRF 防护。
- 设备转移 Preview/CAS 确认；历史录音随设备转移，原 Group 中待处理的交付会被取消。
- 持久化登录限流、最后一名管理员保护、Group 管理员转移/归档规则、离线密码恢复、备份/恢复校验、部署密钥轮换、配额、磁盘水位、数据对账、优雅 Readiness Drain、指标和结构化脱敏日志。
- Webhook DNS/IP Pinning、当前/下一 Secret 轮换、Schema v6 CAS 交付 Lease、Dead Letter 检查/重放，以及需 Preview 确认的历史 Backfill Namespace。
- System Admin Legal Hold，以及经 Preview/CAS 确认、可重试、精确版本的存储对象删除；元数据/审计 Tombstone 保留，实体设备上的源文件明确不受影响。
- TypeScript 与 Python Client、事件校验、WebBluetooth Transport、无界面命令队列、基于 Lit 的标准配网器/控制台 Web Components、React/Vite Admin、可独立部署且可由 Admin 复用的公开 Device Connect Web、跨来源 Callback 校验、Fixture Consumer、统一持久化 Connector Runtime、三个本地输出 Demo、Simulator、Docker Image、Compose 和集成 Skill。
- 固定的已编译协议运行时提供 Browser 与 Node WASM 制品。本仓库校验其包摘要、ABI 和一致性 Hash，且不包含协议源码或 Fixture。
- 已绑定设备管理结合周期性 WebSocket 状态轮询与附近 BLE 的认证状态/控制。OTA 使用本地固件仓库：System Admin 可流式上传自定义包，或从可配置的官方来源（默认 `https://api.voice-can.com/`）显式导入并校验包，然后通过 WebSocket 或 BLE 安装本地副本。

Open Platform 文档：

- [应用、权限、凭据、REST 与管理](docs/open-platform.md)
- [stdio 与远程 MCP](docs/mcp-server.md)
- [Recording Download Grant](docs/recording-download-links.md)

## 明确尚未完成的验证

本仓库不会把仅靠硬件或外部基础设施才能完成的工作描述成已验证。配网、反向绑定、Inventory Discovery、命令恢复、Filesystem/S3/Relay 编排、PostgreSQL 多实例隔离和 Production 部署模板已经实现，但真实 V1.2 设备矩阵仍需要实体固件/硬件证据。真实 MinIO/S3 集成、`private_ca_ip`、签名 OCI/SEA 发布、已部署多实例混合负载验证、外部消息 Provider Adapter 和下游 AI 处理仍处于 Gate 状态。Simulator 与本地集成测试是工程证据，不代表生产就绪。

## 本地快速开始

要求：Node.js `>=24.15.0 <25`、npm，以及一个私有的本地数据目录。

从官方 npm Registry 安装本地 Edge/SQLite 实例：

```sh
npm install --global @voicecan/device-platform@1.0.0
voicecan-device onboard
```

`onboard` 会创建稳定的用户级 Profile、显式迁移 SQLite、安装用户级后台服务（systemd user、launchd 或 Windows 计划任务）、等待 Readiness、打开 Admin，然后退出。数据不再依赖当前工作目录。无界面主机使用 `--no-open`。`init` 保持为兼容别名；只有临时开发进程才使用 `init --foreground`。npm 包没有会修改状态的 `postinstall` Hook，普通的 `serve` 永远不会运行迁移。

```sh
voicecan-device service status --output json
voicecan-device doctor --output json
```

详见[安装与后台服务](docs/installation/README.zh-CN.md)和 [AI 自动化](docs/installation/ai-automation.md)。

每个安装实例只能选择一种安装方式。npm、Docker、专用 Node 与源码安装各有独立生命周期边界；除非遵循迁移手册，否则不要让它们共用同一数据目录。

从公开 `main` 发布通道一键安装 Edge/SQLite，需要先安装 curl、Git、Docker Engine 和 Docker Compose v2：

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh | bash
```

安装器会将 `main` 克隆到 `${XDG_DATA_HOME:-$HOME/.local/share}/voicecan-device-platform`，构建带 Commit Tag 的镜像，在镜像构建期间校验公开代码/协议运行时边界，显式执行迁移，启动仅监听 Loopback 的 Compose Profile，并等待 Readiness。它不会覆盖已有安装。可以通过参数或环境变量覆盖设置，例如：

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install.sh \
  | bash -s -- --install-dir /srv/voicecan-device-platform --port 8788
```

`main` 分支是该安装器的发布通道。安装完成时会输出准确的 Commit 和 Image Tag。升级现有安装前请阅读 [`docs/versioning-and-migrations.md`](docs/versioning-and-migrations.md)；再次运行安装器不会执行原地升级。

不使用 Docker 的原生安装需要 curl、Git、`tar` 和 SHA-256 工具（`sha256sum`、`shasum` 或 OpenSSL）：

```sh
curl -fsSL https://raw.githubusercontent.com/voicecan/device-platform/main/install-node.sh | bash
```

Node.js 安装器不会使用用户的 Node.js、npm、nvm、Homebrew 或系统 PATH。它下载 `node-runtime.lock` 中指定的准确 Runtime，校验平台对应的 SHA-256，并将该专用 Runtime 保存在安装目录中。随后执行相同的源码/运行时制品校验、构建 Release、显式迁移 SQLite，并尝试在 Linux 安装用户级 systemd 服务或在 macOS 安装 launchd Agent。它不会使用 `sudo`。仅需要构建与迁移时传入 `--no-service`。

从源码运行：

```powershell
Copy-Item .env.example .env
npm install
npm run verify:core
npm run build
npm run migrate
npm start
```

服务启动时永远不会自动迁移。首次启动会将高熵 Setup Token 写入仅所有者可读的 `data/setup-token`，日志只记录该文件路径。使用 `node packages/device-server/dist/cli.js show-setup-token` 显式读取，然后通过可信本地 Setup Client 提交；不要把 Token 复制到源码仓库或 Shell History。

如果要丢弃已有本地 Edge 实例并重新初始化，应先停止 Server，删除完整的 `data/` 目录（而不是只删除 SQLite 文件），再运行 `npm run migrate` 并启动 Server。该操作也会删除已存储的 Recording Object 和本地部署 Secret，且无法撤销。Compose Volume、自定义数据/数据库/存储路径和 PostgreSQL/S3 边界详见[重置 Edge 数据并重新初始化](docs/quickstart.md#reset-the-edge-data-and-initialize-again)。

Fixture 开发可设置 `VOICECAN_SIMULATOR=true`。这会暴露带认证的 Simulator Endpoint，生产环境必须保持为 `false`。

打开 `/admin` 完成 Setup、身份、资源和绑定 Origin 的 Provisioning Grant 管理。当安全上下文支持 Web Bluetooth 时，设备配网留在 Admin 内完成；否则 Admin 会打开 `VOICECAN_CONNECT_WEB_URL` 配置的公开 Connector。独立静态包和部署规则见 [Device Connect Web](docs/device-connect-web.md)。`/device` 仍作为同源兼容配网器和控制台提供。

UI 边界是有意设计的：`packages/admin-web` 是带认证的管理界面，`packages/device-connect-web` 是可复用且可独立部署的浏览器 Connector，`packages/device-ui` 是框架无关的 Lit Custom Element Library，`packages/device-web` 则是纯 TypeScript Headless SDK。`npm run build` 会生成全部三个前端制品。前端开发时，使用 `npm run dev` 运行 API，使用 `npm run dev:admin` 运行 Admin，使用 `npm run dev --workspace @voicecan/device-connect-web` 运行独立 Connector（默认 `http://127.0.0.1:5175/`）。

## Open Platform npm 包

完整本地 Server 发行包和三个应用 SDK 均通过官方 npm Registry 的 `@voicecan` Scope 发布：

- `@voicecan/device-platform`：自包含的 Server、Admin、设备 UI、经过审查的已编译协议运行时，以及 `voicecan-device` CLI；
- `@voicecan/contracts`：仅包含公开 Contract 与常量；
- `@voicecan/server-client`：Application REST Client、Event Cursor、安全 Recording Grant 下载、Webhook 校验/解析和 Media Assessment；
- `@voicecan/connector-runtime`：持久化 Webhook Dispatch、SQLite Inbox/Tombstone/Outbox/Metrics，以及可感知授权的 Recording Reconciliation。

```bash
npm install @voicecan/contracts @voicecan/server-client @voicecan/connector-runtime
```

应用代码不应依赖 `@voicecan/device-platform`；仅在部署 Server 时安装它。发布前运行 `npm run npm:pack:check`。发布检查会确认 Server Tarball 包含 Admin/UI 和经过审查的协议运行时 JS/WASM 制品，同时不会发布协议源码。

离线操作必须在 Server 停止时执行：

```powershell
node packages/device-server/dist/cli.js backup create D:\backups\voicecan-2026-08-03
node packages/device-server/dist/cli.js backup verify D:\backups\voicecan-2026-08-03
node packages/device-server/dist/cli.js backup restore D:\backups\voicecan-2026-08-03 D:\voicecan-restored
"new passphrase" | node packages/device-server/dist/cli.js users set-password --username admin --password-stdin
node packages/device-server/dist/cli.js keys rotate
```

## 验证

运维发布 Gate 见[运维手册](docs/operations-runbook.md)、[SLO/容量/告警](docs/slo-capacity-and-alerting.md)和[隐私/保留/灾难恢复](docs/privacy-retention-and-disaster-recovery.md)。`/metrics` 暴露稳定 Route 的 HTTP 延迟、事件循环健康、设备连接、存储容量，以及文件/Webhook/命令队列饱和度；应只允许私有监控网络访问。

```powershell
npm run typecheck
npm test
npm run check:public
npm run verify:core
npm run build
```

自动化测试覆盖 Setup/Claim 重放拒绝、Origin Binding、持久化限流、生命周期 Guard、不可变上传恢复、备份/恢复、密钥轮换、SSRF 地址分类、Group 隔离、转移授权、Connector Fan-out、Skill Forward Fixture、WASM 一致性、Gateway 事件解析、React Admin 构建/制品交付和 Lit Custom Element Contract 保持。Admin 包含专用的 User/Group/Token/Webhook 生命周期 Form，以及受 Guard 保护的 API、Delivery 和 Simulator 工具。实体 BLE 权限与设备结果仍属于硬件发布 Gate。

更多资料：[快速开始](docs/quickstart.md)、[本地固件仓库与 OTA](docs/firmware-repository.md)、[Device Connect Web 部署](docs/device-connect-web-deployment.md)、[OpenAPI](docs/openapi.yaml)、[错误码](docs/error-codes.md)、[Connector 与 Demo](docs/connectors-and-demos.md)、[运维手册](docs/operations-runbook.md)、[版本与迁移](docs/versioning-and-migrations.md)、[许可证 Gate](docs/licensing-decision.md)、[安全模型](docs/security.md)、[协议运行时依赖边界](docs/repository-boundary.md)和[实现状态](docs/implementation-status.md)。
