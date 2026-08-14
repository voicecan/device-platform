# 安装与后台持续运行

[English](README.md)

## 推荐的 npm 安装

要求 Node.js `>=24.15 <25` 和 npm。

```bash
npm config set @voicecan:registry https://registry.npmjs.org/
npm install --global @voicecan/device-platform@1.0.0
voicecan-device onboard
```

`onboard` 会写入稳定的 `default` Profile、显式迁移 SQLite、安装并启动当前用户的后台服务、等待 `/health/ready`、打开 Admin，然后退出。用 `--profile <name>` 隔离多个实例；无界面主机使用 `--no-open`。

Linux Profile 默认位于 XDG Data，macOS 位于 Application Support，Windows 位于 `%LOCALAPPDATA%\Voicecan\DevicePlatform`。`VOICECAN_HOME` 可以覆盖根目录。当前进程中的环境变量优先于 Profile。

## 生命周期命令

```bash
voicecan-device service status --output json
voicecan-device service restart --output json
voicecan-device service logs
voicecan-device doctor --output json
```

Linux 使用 systemd user，macOS 使用 LaunchAgent，Windows 使用当前用户的计划任务。服务定义只调用 Profile 下的稳定 Wrapper；通过 `npx` 安装时，会先把 Runtime 固化到 Profile，后台服务不会依赖临时 npm Cache。

`serve` 只以前台方式运行且永远不迁移。`init` 是 `onboard` 的兼容别名；旧的开发方式使用 `init --foreground`。

首次 Setup 必须在可信 Admin 页面中由用户完成，自动化不得读取或输出 Setup Token 与管理员密码。Docker/Compose、专用 Node 和 npm/native 是互斥的生命周期选择，不得叠加到同一个可写数据目录。
