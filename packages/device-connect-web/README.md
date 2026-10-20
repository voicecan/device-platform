# Voicecan Device Connect Web

[中文](README.zh-CN.md)

This browser device-connection package can be deployed on its own or reused by Admin. On the user’s current computer it handles device provisioning and Wi-Fi setup. It does not host the Voicecan Device Server API and does not store provisioning credentials.

Client system, browser, HTTPS, and permission requirements for provisioning are in [Client system requirements](../../docs/device-connect-web.md#客户端系统要求).

## Build and deploy

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

## Enable it in Admin

Device Server configuration:

```env
VOICECAN_CONNECT_WEB_URL=https://connect.example.com/
```

The URL must be HTTPS and must not include a username, password, query string, or fragment. Local development may use `http://127.0.0.1`, `http://localhost`, or `http://[::1]`.

Admin chooses a path automatically:

1. When the current page is a secure browser context, mount `mountDeviceConnector()` from this package and keep the flow in Admin.
2. Otherwise, after the user clicks “Bind in browser”, open `VOICECAN_CONNECT_WEB_URL` directly.

“Secure context” is used here because browsers also treat loopback HTTP as a secure context, so checking that the URL starts with HTTPS is not enough.

## Cross-origin messaging and the return callback

The public connect page does not call a NAS or local Device Server directly. Admin keeps the one-time provisioning credential and continuation token, and proxies four narrow operations over a one-time `MessageChannel`: `claim`, `progress`, `observe`, and `complete`.

- Provisioning credentials, CSRF tokens, cookies, and the continuation token stay out of the URL and are not sent to the public connect site.
- Temporary device credentials pass only through an in-memory `MessagePort`. They are not written to disk or browser storage.
- When the public page finishes, it returns to the original Admin page with `#vc_connect=...`. The fragment contains only the protocol version, a one-time session id, `state`, the result, the provisioning session id, the device id, and the completion time. It contains no secrets.
- Admin checks the locally stored `state` and the 15-minute limit, clears the fragment immediately, then calls local `GET /api/v1/provisioning-sessions/{id}` again. The page shows the local server’s authoritative status instead of trusting the callback’s own success report.

The public connect site is a trusted software-supply boundary: a fixed domain, HTTPS, strict response headers, no third-party scripts, and the same release review as any other production frontend.

## Network conditions

Device Server can run on a NAS or a remote server. The Wi-Fi network chosen during provisioning must let the device reach that Device Server’s device endpoint. The current product flow requires the device and the server to be on the same network. The Wi-Fi name and password stay in page memory only for that provisioning session.

The connection wizard connects to the device first, then shows the device’s current network status. The user can keep the existing network or submit a new Wi-Fi configuration. The wizard keeps polling device status and writes the Server address only after the network is usable, then waits for the Server to confirm that the device is online.
