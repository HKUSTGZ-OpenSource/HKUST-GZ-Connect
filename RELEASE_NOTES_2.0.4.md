# HKUST(GZ) Connect 2.0.4

- Status: Release candidate — 正式发布及安装包验收记录在 GitHub Release
- Owner: project maintainers
- Last verified: 2026-10-09
- Applies to: 2.0.4

## 中文

- 修复断网、休眠或网络切换后，登录请求超时、连接重置等网络故障被误判为“登录结果无法确认”并永久停止自动连接的问题。
- 启用“自动重连”且重试次数大于 0 时，断网保留连接意图，恢复联网后自动连接；网关暂时不可达时，在短期重试后每 30 秒继续尝试，无需再次点击连接开关。
- 修复断网后旧进程已关闭，但远端注销无法确认仍阻止自动恢复的问题。手动断开、退出、关闭自动重连和明确的账号密码拒绝继续停止重试。
- 修复更新通知无法打开已验证的版本页面、受保护凭据存储暂不可用时内存凭据无法使用，以及 Windows 备用网卡选择的问题。
- 支持其他 EasyConnect 网关的跳转入口检查和限定到目标网关的证书信任，完善按用户选择导出的网关转发配置。
- 修复校园浏览器在关闭、切换账户或切换网络路径后的异步操作干扰新页面、凭据保存和路由激活的问题；完善连接、浏览器和界面模块的独立生命周期。
- 更新经过兼容性验证的依赖及打包工具，保留 Electron 43。

升级保留现有设置和凭据。未知认证协议和不支持的 MFA 继续停止重试。网络恢复回归使用合成故障与原生 Electron；真实学校网关验收与安装包验收分别记录。

## English

- Recover automatically after an outage, sleep or a network change instead of treating HTTP timeouts and connection resets as a terminal indeterminate login result.
- Keep connection intent while offline when Auto Reconnect is enabled and the retry count is above zero. After the short retry burst, retry a temporarily unreachable gateway every 30 seconds.
- Allow outage recovery after the old Engine closes even when remote logout cannot be confirmed. Manual disconnect, quitting, disabled recovery and explicit credential rejection still stop retries.
- Fix verified update links, memory credentials when protected storage is unavailable, and Windows fallback adapter selection.
- Support checked redirect entries and origin-bound certificate trust for other EasyConnect gateways, and improve explicitly selected gateway-forwarding exports.
- Fence retired Browser, credential and routing operations to their original context and improve independent module lifecycles.
- Update validated compatible dependencies and packaging tools while retaining Electron 43.

Existing settings and credentials are preserved. Unknown authentication protocols and unsupported MFA still stop recovery. Synthetic/native Electron tests do not establish live-school acceptance; consult the GitHub Release for package evidence.
