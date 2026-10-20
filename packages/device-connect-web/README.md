# Voicecan Device Connect Web

[English](#english) · [中文](#中文)

## English

This browser device-connection package can be deployed on its own or reused by Admin. On the user’s current computer it handles device provisioning and Wi-Fi setup. It does not host the Voicecan Device Server API and does not store provisioning credentials.

Client system, browser, HTTPS, and permission requirements for provisioning are in [Client system requirements](../../docs/device-connect-web.md#客户端系统要求).

### Build and deploy

From the repository root:

```sh
npm ci
npm run build --workspace @voicecan/device-connect-web
```

Deploy every file in `packages/device-connect-web/dist/` unchanged to a public HTTPS site. The output contains the page, styles, a single script, and the reviewed browser WASM build of the protocol runtime. It does not include protocol source or test fixtures.

You can also build a standalone Docker image from the repository root:

```sh
docker build -f packages/device-connect-web/Dockerfile -t voicecan/device-connect-web:local .
docker run --rm -p 127.0.0.1:8080:8080 voicecan/device-connect-web:local
```

The container runs as the non-root `nginx` user and serves HTTP on `8080` only. Public TLS must be terminated by an Ingress or reverse proxy. Docker, HTTPS, the Gitea amd64 image build, Kubernetes deployment, and acceptance checks are in the [standalone deployment guide](../../docs/device-connect-web-deployment.md).

With nginx, mount `dist/` at `/usr/share/nginx/html` and reuse [deploy/nginx.conf](deploy/nginx.conf). Two settings in that config must stay as they are:

- `Cross-Origin-Opener-Policy` must be `unsafe-none`. Otherwise the browser isolates the `opener` / `MessageChannel` handshake between a cross-origin Admin page and the connect page.
- The CSP Trusted Types allowlist must keep `voicecan lit-html sanitizer`.

Do not add analytics, support, or other third-party scripts to the connect site. The build uses fixed `connect.js`, `connect.css`, and protocol-runtime filenames, so every response uses `Cache-Control: no-store` to keep the frontend runtime and WASM versions matched.

### Enable it in Admin

Device Server configuration:

```env
VOICECAN_CONNECT_WEB_URL=https://connect.example.com/
```

The URL must be HTTPS and must not include a username, password, query string, or fragment. Local development may use `http://127.0.0.1`, `http://localhost`, or `http://[::1]`.

Admin chooses a path automatically:

1. When the current page is a secure browser context, mount `mountDeviceConnector()` from this package and keep the flow in Admin.
2. Otherwise, after the user clicks “Bind in browser”, open `VOICECAN_CONNECT_WEB_URL` directly.

“Secure context” is used here because browsers also treat loopback HTTP as a secure context, so checking that the URL starts with HTTPS is not enough.

### Cross-origin messaging and the return callback

The public connect page does not call a NAS or local Device Server directly. Admin keeps the one-time provisioning credential and continuation token, and proxies four narrow operations over a one-time `MessageChannel`: `claim`, `progress`, `observe`, and `complete`.

- Provisioning credentials, CSRF tokens, cookies, and the continuation token stay out of the URL and are not sent to the public connect site.
- Temporary device credentials pass only through an in-memory `MessagePort`. They are not written to disk or browser storage.
- When the public page finishes, it returns to the original Admin page with `#vc_connect=...`. The fragment contains only the protocol version, a one-time session id, `state`, the result, the provisioning session id, the device id, and the completion time. It contains no secrets.
- Admin checks the locally stored `state` and the 15-minute limit, clears the fragment immediately, then calls local `GET /api/v1/provisioning-sessions/{id}` again. The page shows the local server’s authoritative status instead of trusting the callback’s own success report.

The public connect site is a trusted software-supply boundary: a fixed domain, HTTPS, strict response headers, no third-party scripts, and the same release review as any other production frontend.

### Network conditions

Device Server can run on a NAS or a remote server. The Wi-Fi network chosen during provisioning must let the device reach that Device Server’s device endpoint. The current product flow requires the device and the server to be on the same network. The Wi-Fi name and password stay in page memory only for that provisioning session.

The connection wizard connects to the device first, then shows the device’s current network status. The user can keep the existing network or submit a new Wi-Fi configuration. The wizard keeps polling device status and writes the Server address only after the network is usable, then waits for the Server to confirm that the device is online.

---

## 中文

这是可独立部署、也可被管理端复用的浏览器设备连接包。它只负责在用户当前电脑上完成设备配网和 Wi-Fi 配置，不承载 Voicecan Device Server API，也不保存配网凭证。

用于配网的客户端系统、浏览器、HTTPS 和权限要求见[客户端系统要求](../../docs/device-connect-web.md#客户端系统要求)。

### 构建与部署

从仓库根目录执行：

```sh
npm ci
npm run build --workspace @voicecan/device-connect-web
```

将 `packages/device-connect-web/dist/` 中的全部文件原样部署到一个公网 HTTPS 站点。产物包含页面、样式、单文件脚本以及经过审查的协议运行时 Browser WASM 编译产物，不包含协议源码或测试 Fixture。

也可以从仓库根目录构建独立 Docker 镜像：

```sh
docker build -f packages/device-connect-web/Dockerfile -t voicecan/device-connect-web:local .
docker run --rm -p 127.0.0.1:8080:8080 voicecan/device-connect-web:local
```

容器以非 root `nginx` 用户运行，只提供 HTTP `8080`；公网 TLS 必须由 Ingress 或反向代理终止。完整的 Docker、HTTPS、Gitea amd64 镜像构建、Kubernetes 部署和验收说明见 [独立部署指南](../../docs/device-connect-web-deployment.md)。

若使用 nginx，可将 `dist/` 挂载到 `/usr/share/nginx/html`，并复用 [deploy/nginx.conf](deploy/nginx.conf)。该配置有两个不可随意收紧的点：

- `Cross-Origin-Opener-Policy` 必须为 `unsafe-none`，否则跨来源管理端与连接页之间的 `opener`/`MessageChannel` 握手会被浏览器隔离。
- CSP 的 Trusted Types 白名单需要保留 `voicecan lit-html sanitizer`。

连接站点不得加入统计、客服或其他第三方脚本。当前产物使用固定的 `connect.js`、`connect.css` 和协议运行时文件名，因此所有响应都使用 `Cache-Control: no-store`，防止前端运行时与 WASM 版本错配。

### 在管理端启用

Device Server 配置：

```env
VOICECAN_CONNECT_WEB_URL=https://connect.example.com/
```

该地址必须是 HTTPS 且不能包含账号密码、查询参数或 Fragment；只有本地开发允许 `http://127.0.0.1`、`http://localhost` 或 `http://[::1]`。

管理端的自动选择规则为：

1. 当前页面是浏览器安全上下文：直接挂载本包导出的 `mountDeviceConnector()`，流程不离开管理端。
2. 其他情况：用户在管理端点击“在网页端绑定”后，直接打开 `VOICECAN_CONNECT_WEB_URL`。

这里使用“安全上下文”而不是只检查 URL 是否以 HTTPS 开头，因为浏览器也把 loopback HTTP 视为安全上下文。

### 跨来源通信与回调

公网连接页不会直接请求 NAS/本地 Device Server。管理端保留一次性配网凭证和 continuation token，并通过一次性 `MessageChannel` 代理四种窄操作：`claim`、`progress`、`observe`、`complete`。

- 配网凭证、CSRF、Cookie 和 continuation token 不进入 URL，也不会发送给公网连接站点。
- 临时设备凭证仅通过内存中的 `MessagePort` 传递，不落盘、不进入浏览器存储。
- 公网页完成后，以 `#vc_connect=...` 跳回原管理页面。Fragment 只包含协议版本、一次性会话 ID、`state`、结果、配网会话 ID、设备 ID 和完成时间，不包含任何密钥。
- 管理端校验本地保存的 `state` 和 15 分钟时限，立即清除 Fragment，然后再次调用本地 `GET /api/v1/provisioning-sessions/{id}`。页面最终展示的是本地服务器的权威状态，而不是相信回调自报成功。

公网连接站点属于受信任的软件供应链边界：固定域名、HTTPS、严格响应头、无第三方脚本，并按普通生产前端执行发布审查。

### 网络条件

Device Server 可以运行在 NAS 或远程服务器上。配网时选择的 Wi-Fi 必须使设备能够访问该 Device Server 的设备入口；当前产品流程要求设备与服务器处于同一个网络。Wi-Fi 名称和密码只在本次配网期间保存在页面内存中。

连接向导先连接设备，再展示设备当前网络状态。用户可以保留现有网络，也可以提交新的 Wi-Fi 配置；向导会持续轮询设备状态，确认网络可用后才写入 Server 地址，随后等待 Server 确认设备上线。
