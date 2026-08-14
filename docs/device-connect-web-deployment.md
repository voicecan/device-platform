# 独立 Device Connect Web 部署指南

本文说明如何将 `packages/device-connect-web` 作为一个独立公网 HTTPS 站点部署。该站点是纯静态 Web，不需要数据库，不连接 Device Server，也不保存配网凭证。

## 1. 部署拓扑

推荐拓扑：

```text
用户 Chromium 浏览器
  ├─ 原管理页面：http(s)://NAS-or-Server/admin
  └─ 公网连接页：https://connect.example.com
                         │
                         └─ TLS Ingress / CDN / Reverse Proxy
                                   │
                                   └─ device-connect-web:8080
```

容器只监听 HTTP `8080`，公网 HTTPS 证书应由 Ingress、负载均衡器或经过审核的反向代理终止。连接页与管理端通过浏览器 `opener` 和转移后的 `MessageChannel` 通信，连接页不会直接访问 NAS 或本地 Device Server。

## 2. 前置条件

- 一个固定公网域名，例如 `connect.example.com`；
- 受浏览器信任的 HTTPS 证书；
- 满足[客户端系统要求](device-connect-web.md#客户端系统要求)的 Chromium 浏览器和 BLE 适配器；
- Device Platform 中的 `VOICECAN_CONNECT_WEB_URL` 指向该 HTTPS 地址；
- 入口层不得注入第三方脚本，也不得把 `Cross-Origin-Opener-Policy` 改成 `same-origin`。

## 3. 从源码构建静态文件

要求 Node.js `24.15.x`：

```sh
npm ci --ignore-scripts
npm run check:public
npm run verify:core
npm run build --workspace @voicecan/device-connect-web
```

部署 `packages/device-connect-web/dist/` 内的全部文件，不能遗漏语义门面 `semantic_core.js` 或 `protocol_core_bg.wasm`。制品不再发布可独立导入的原始命令胶水层。

## 4. 构建 Docker 镜像

Docker 构建上下文必须是仓库根目录，因为构建需要 workspace lockfile、受审查的 `vendor` 协议运行时制品以及依赖包：

```sh
docker build \
  -f packages/device-connect-web/Dockerfile \
  -t voicecan/device-connect-web:local \
  .
```

Dockerfile 使用 Node 24.15 多阶段构建，先校验固定协议运行时制品并构建静态文件，再复制到非 root nginx 运行阶段。运行镜像：

```sh
docker run --rm \
  --name voicecan-device-connect-web \
  -p 127.0.0.1:8080:8080 \
  voicecan/device-connect-web:local
```

可选的只读根文件系统运行方式：

```sh
docker run --rm \
  --name voicecan-device-connect-web \
  --read-only \
  --tmpfs /var/cache/nginx:uid=101,gid=101 \
  --tmpfs /run:uid=101,gid=101 \
  -p 127.0.0.1:8080:8080 \
  voicecan/device-connect-web:local
```

健康检查地址为 `http://127.0.0.1:8080/index.html`。生产环境不要直接把这个 HTTP 端口暴露到公网。

## 5. HTTPS 入口要求

镜像内置的 [`nginx.conf`](../packages/device-connect-web/deploy/nginx.conf) 会为所有响应设置：

- CSP：只允许本站脚本、样式和 WASM，启用 Trusted Types；
- `Permissions-Policy: bluetooth=(self)`；
- `Cross-Origin-Opener-Policy: unsafe-none`；
- `Referrer-Policy: no-referrer`；
- `X-Content-Type-Options: nosniff`；
- `Cache-Control: no-store`，避免固定文件名的浏览器运行时代码变旧。

Ingress/CDN 可以补充 HSTS，但必须保留上述响应头。特别注意：`COOP: same-origin` 会切断跨来源管理端的握手，导致连接页一直显示“请从 Voicecan 管理端打开此页面”。

部署后检查：

```sh
curl -fsSI https://connect.example.com/
curl -fsSI https://connect.example.com/protocol_core_bg.wasm
```

同时确认 WASM 返回成功，并检查响应中存在 CSP、Permissions-Policy、COOP、no-store 和 nosniff。

## 6. 配置 Device Platform

Device Server 环境变量：

```env
VOICECAN_CONNECT_WEB_URL=https://connect.example.com/
```

重启 Device Server 后访问 `/admin`。非安全上下文或当前浏览器不支持 Web Bluetooth 时，设备配网页会显示打开公网连接页的操作；安全上下文且支持 BLE 时仍直接使用内嵌连接组件。

## 7. Gitea 构建与部署

工作流文件为 [`.gitea/workflows/device-connect-web-image.yaml`](../.gitea/workflows/device-connect-web-image.yaml)。它参考 Admin Web 和 Main Service 的发布方式：

- 推送到 `test` 分支时自动构建并部署到 TEST 集群；
- 也可以通过 `workflow_dispatch` 手动指定集群、命名空间或已有镜像 tag；
- 复用 `${{ vars.REGISTRY_URL }}/runner-base:v1` 中的 Docker、Buildx、SSH 和 kubectl；
- 在固定 Node 24.19.0 的 Docker 构建阶段执行一次 `npm ci`，并通过 BuildKit 缓存 npm 下载目录；
- 镜像推送前在同一构建阶段执行公开边界、协议运行时制品、类型、构建和连接页相关测试；
- 只构建 `linux/amd64`，直接推送 `${REGISTRY_URL}/voicecan-device-connect-web:<tag>`；
- 渲染 [`packages/device-connect-web/deploy/deploy.template`](../packages/device-connect-web/deploy/deploy.template)，通过 SSH 应用到 Kubernetes 并等待 Deployment rollout。

手动运行时，`image_tag` 留空会生成 `<时间>_<git describe>` tag 并构建新镜像；指定已有 tag 时会跳过构建和推送，直接部署该版本，可用于回滚。集群需要配置与其他服务相同的仓库变量、凭据和部署 Secret：

```text
REGISTRY_URL
REGISTRY_USERNAME
REGISTRY_PASSWORD
DEPLOY_IP_TEST / DEPLOY_IP_PROD
DEPLOY_SSH_USER_TEST / DEPLOY_SSH_USER_PROD
DEPLOY_SSH_KEY_TEST / DEPLOY_SSH_KEY_PROD
```

生成的模板只包含 Namespace、ClusterIP Service 和 Deployment，不创建公网 Ingress。TLS 域名、证书和入口响应头仍由集群侧受审查的 Ingress/CDN 管理。连接页没有数据库迁移。

## 8. 上线验收

- 公网 URL 使用受信任 HTTPS，页面无混合内容；
- 页面中英文均可随管理端会话切换；
- 管理端 HTTP/NAS 场景能打开公网连接页；
- 配网凭证、CSRF、Cookie、continuation token 均未出现在 URL、日志或公网请求中；
- 回调返回管理端后，会再次查询本地配网会话状态；
- 第一步先完成 GATT 连接、设备身份读取、绑定 Token 领取与 BLE 安全握手，成功前不能进入网络配置；
- Wi-Fi 页面显示设备必须与 Server 处于同一网络的提示；
- 使用实体 Voicecan 设备完成一次 BLE 配网和首次上线确认。
