# HKUST(GZ) Connect 2.0.5

- Status: Release candidate; publication and artifact acceptance tracked in #283
- Owner: project maintainers
- Last verified: 2026-10-30
- Applies to: the versioned 2.0.5 source; installer availability is established by GitHub Release

## 中文

### 学校切换与启动恢复

- 修复保存、更新或移除登录凭据后无法切回其他学校的问题。切换读取最新的账户状态，并继续严格核对学校、账户和工作区归属。
- 修复旧版本切换失败后，重新启动反复出现 `source-validation` 错误的问题。应用在身份、事务记录和清理检查通过后恢复原切换，不要求清空账号、收藏或浏览器数据。

### 校园浏览器与门户读取

- 修复关闭或重新创建浏览器时，旧会话和迟到的代理配置干扰新窗口的问题；保留 Cookie 与网站登录状态。
- 修复旧窗口的打开网站、工具栏和查找结果继续更新新窗口或显示过期错误的问题。
- 浏览器关闭失败或被网页阻止时保留必要的资源管理信息，阻止旧页面借用新连接权限，并允许重新清理。
- 门户请求的超时覆盖完整响应正文，避免收到响应头后仍无限等待；适用于现有分类、课表及其他门户读取流程。

### 安全与维护

- 更新至 Electron 43.8.1，纳入受影响证书信任的安全修复，保持 Electron 43 系列兼容范围。
- 更新兼容的 HTTP 构建依赖与 URI 解析补丁，精确锁文件安全审计通过。
- 更新 Rustls 至 0.23.46 及配套兼容依赖，纳入 TLS 证书处理、会话调试信息和连接状态相关的安全修补。
- 汇总此前已合并的模块生命周期和依赖整理，升级保留现有设置与数据。

## English

- Fix switching schools after saving, replacing or removing login credentials by reading the current validated account authority.
- Recover older interrupted switches that otherwise blocked startup at `source-validation`, without resetting accounts, favorites or browser data. Identity, transaction and cleanup checks remain mandatory.
- Prevent retired Browser Sessions, proxy updates and toolbar/find completions from interfering with replacement windows; preserve cookies and website sessions.
- Retain ownership after failed or vetoed Browser disposal, block stale access and allow cleanup retry.
- Keep portal request deadlines active until the response body completes, preventing indefinite reads after headers arrive.
- Update Electron to 43.8.1 and compatible HTTP/URI build dependencies, retaining the Electron 43 compatibility line.
- Update Rustls to 0.23.46 and compatible Rust dependencies for TLS certificate handling, session-debug disclosure and connection-state security fixes.

## 验证边界 / Verification scope

Release acceptance requires the exact-tag native build, unit/lifecycle tests, Electron regressions,
package verification and launch smoke on supported platforms. Consult the release build receipt
and checksum manifest for executed results and actual signing state; this source note alone does
not establish a published installer or real gateway acceptance.

The separate intermittent gateway forbidden-address report (#282) and original real-school
calendar/Windows reporter acceptance are not claimed fixed by this release. Unknown authentication
and disallowed gateway addresses remain fail-closed. No system DNS, route, TUN or active third-party
proxy profile is changed by these fixes.
