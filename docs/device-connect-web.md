# 独立设备连接 Web 使用说明

`packages/device-connect-web` 是 Device Platform 内置的独立静态 Web 包。它解决 Device Server 部署在 NAS、Linux 服务器或无蓝牙主机上，而访问管理端的电脑具有蓝牙的场景。

包的使用与通信约束见 [包内 README](../packages/device-connect-web/README.md)；Docker、HTTPS 入口、Gitea 构建部署和上线验收见 [独立部署指南](device-connect-web-deployment.md)。

## 客户端系统要求

Device Connect Web 使用 Web Bluetooth 与 VoiceCan 设备的 BLE GATT 服务通信。运行连接页的客户端必须具有支持 BLE 4.0 或更高版本的蓝牙适配器，并开启操作系统蓝牙、浏览器蓝牙权限和站点蓝牙权限。Device Server 所在的 NAS 或远程服务器不需要蓝牙。

| 客户端平台 | Web Bluetooth 上游最低条件 | Device Connect Web 建议环境 |
| --- | --- | --- |
| Windows | Windows 10 1703+；Chrome 70+ 或 Edge 79+ | Windows 10/11，使用最新稳定版 Chrome 或 Edge |
| macOS | OS X 10.10 Yosemite+；Chrome 56+ | 仍受支持的 macOS，使用最新稳定版 Chrome 或 Edge，并允许浏览器访问系统蓝牙 |
| Android | Android 6.0+；Chrome | Android 10+，使用最新稳定版 Chrome；不要使用应用内 WebView |
| ChromeOS | 具有 BLE 硬件的 ChromeOS 设备 | 保持 ChromeOS 和 Chrome 为最新稳定版 |

上表中的上游最低版本只表示浏览器提供基本的设备选择、GATT 连接、Characteristic 读写和 Notification 能力，不表示旧系统仍处于厂商安全支持期。生产使用应以“建议环境”为准，并至少验证当前及前一个 Chromium 稳定版本。

以下环境不属于支持范围：

- iPhone 和 iPad 上的 Safari、Chrome、Edge 及安装到主屏幕的 PWA；iOS/iPadOS 的 WebKit 不提供 Web Bluetooth；
- macOS Safari 和所有平台的 Firefox；
- Android WebView 和应用内置浏览器；
- Linux 上的 Chrome/Chromium。其实现仍依赖 Kernel、BlueZ 和实验功能开关，只适合开发诊断，不作为生产配网入口；
- Bluetooth Classic 设备。连接页只支持 BLE GATT。

除系统和浏览器版本外，页面还必须满足以下条件：

- 连接页运行在受信任的 HTTPS 安全上下文中；只有本地开发的 `localhost`、`127.0.0.1` 和 `[::1]` 可使用 HTTP；
- 响应头允许当前来源使用蓝牙，即 `Permissions-Policy: bluetooth=(self)`；
- 用户必须通过页面按钮主动打开浏览器设备选择器，浏览器不允许页面静默扫描或自动选择设备；
- 企业浏览器策略、操作系统隐私设置或站点权限不得禁用蓝牙；
- VoiceCan 设备处于附近并进入可发现/配对状态。

页面可使用 `isSecureContext && 'bluetooth' in navigator` 做入口能力检测，但检测通过不代表蓝牙适配器已开启或权限已授予；最终仍以用户选择设备并成功建立 GATT 连接为准。上游兼容性依据见 [Chrome Web Bluetooth 文档](https://developer.chrome.com/docs/capabilities/bluetooth)、[Web Bluetooth 实现状态](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)和 [Microsoft Edge Web Bluetooth 策略文档](https://learn.microsoft.com/deployedge/microsoft-edge-browser-policies/defaultwebbluetoothguardsetting)。

## 使用流程

1. 管理员在 `/admin?view=provision` 选择目标用户组，创建 10 分钟设备绑定凭证。
2. 管理端检查 `isSecureContext` 和 `navigator.bluetooth`。
3. 若当前管理端可直接使用 Web Bluetooth，则在管理页面内完成设备绑定。
4. 若不可用，则用户点击“开始绑定”时直接打开配置的公网 HTTPS 连接页。
5. 安全会话连接后，用户在连接页点击“选择设备并开始绑定”，由这个用户手势打开浏览器蓝牙设备选择器。连接页只操作当前电脑的 BLE，并严格按 App 顺序执行：连接 GATT、读取设备身份、向 Server 领取绑定 Token、完成 BLE Token 安全握手；只有这四步成功后才读取、展示设备当前网络状态。所有 NAS/本地 Server 请求仍由原管理页面发起。
6. 用户选择保留现有网络或填写新的 Wi-Fi 配置；页面持续读取设备状态，只有网络变为可用后才写入服务器地址。
7. 连接页等待 Server 确认设备上线；完成后返回管理端，管理端校验一次性 `state`，再向 Server 查询绑定会话的权威状态。

> 配网选择的 Wi-Fi 必须让设备与 VoiceCan Platform Server 处于同一个网络，否则设备无法完成首次回连与上线确认。

## 运维配置

```env
VOICECAN_CONNECT_WEB_URL=https://connect.voice-can.com/
```

修改后重启 Device Server。Server 会把该地址注入 Admin HTML；地址非法时启动失败，避免静默回退到不安全 HTTP。

独立发布连接页：

```sh
npm run build --workspace @voicecan/device-connect-web
```

部署目录为 `packages/device-connect-web/dist/`。上线前至少验证：

- 页面通过受信任的公网 HTTPS 访问；
- Chromium 的站点权限允许蓝牙；
- `Permissions-Policy` 包含 `bluetooth=(self)`；
- `Cross-Origin-Opener-Policy` 没有设置为 `same-origin`；
- CSP 允许自身脚本、WASM 和 `voicecan lit-html sanitizer` Trusted Types policy；
- 页面没有第三方脚本、外链资源或敏感信息日志。

也可以使用专用 Dockerfile：

```sh
docker build -f packages/device-connect-web/Dockerfile -t voicecan/device-connect-web:local .
```

Gitea 中的 `device-connect-web-image` 工作流在推送到 `test` 分支时自动执行，也支持手动选择目标集群、命名空间或已有镜像 tag。它只构建 `linux/amd64` 镜像，推送到内网仓库后通过 SSH 部署独立的 Kubernetes Service 和 Deployment；公网 TLS/Ingress 仍由集群侧管理。
