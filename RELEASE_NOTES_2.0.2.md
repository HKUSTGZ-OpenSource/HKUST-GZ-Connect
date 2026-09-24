# HKUST(GZ) Connect 2.0.2

Status: Release candidate — publication and artifact verification are recorded in the GitHub Release.
Owner: project maintainers
Last verified: 2026-09-07
Applies to: 2.0.2

## 中文

- 修复停止/重连时旧连接失效后关闭确认被丢弃的问题，避免不必要的关闭请求超时；仍需确认引擎正常退出，不跳过清理失败保护。
- 修复部分 Windows 权限环境下无法安全写入连接进程归属记录、首次连接误报会话清理失败的问题；未正常退出时的重连保护仍保留。
- 周课表支持任选日期、上一周/下一周及回到本周。
- 按周保留最近 12 周的会话内缓存，24 小时内优先显示缓存；手动刷新保留已有课表，不再整卡变成加载占位。网络失败时保留上次结果并明确提示，未读取过的周使用紧凑加载状态。
- 相同内容刷新后不重建课表，避免闪烁和打断详情查看。缓存仅在内存中保存；退出应用、切换账户或清除校园浏览器数据后重新读取。登录失效不会当作普通网络失败继续展示旧缓存。
- 小窗七天完整呈现、无横向拖动条；并发安排合并为可展开的详情入口，详情弹窗居中。
- “我的分类”跟随官方服务台：窄窗堆叠、宽窗并列；保留收藏、分类顺序、查看更多、分页、键盘和减少动态效果支持。
- 提供 macOS Apple Silicon/Intel、Windows x64 和 Linux x64 安装包。实际签名、公证和各平台验收结果以发布收据为准。

本次不改 VPN 协议、凭据存储格式或系统代理设置，不包含尚未合并的治理/模块化候选。真实校园 MFA 仍由用户在浏览器中完成；本地模拟测试不等同于真实学校验收。

## English

- Preserve replies to the owned Engine's pending shutdown after connection invalidation, avoiding unnecessary control-request timeouts while retaining clean-exit and cleanup-failure checks.
- Fix secure Engine ownership-record creation in affected Windows permission environments, which could incorrectly stop initial connection with a cleanup warning. Unclean-exit reconnect protection remains enabled.
- Select any calendar week, move between weeks, or return to the current week.
- Keep up to 12 weeks in session memory, reuse results for 24 hours, and refresh without clearing the timetable. Failed updates retain the last result with an explicit notice; uncached weeks have a compact loading state.
- Unchanged results preserve the existing timetable DOM and open details. Cache is not persisted to disk and is retired on app exit, account switching or browser-data clearing. Explicit authentication expiry revokes cached results.
- Miniature seven-day timetable without horizontal scrolling; grouped concurrent events and centered details.
- Personal categories stack in narrow windows and spread side by side in wide windows, consistently with the official service desk.
- macOS Apple Silicon/Intel, Windows x64 and Linux x64 packages. Consult the release receipt for actual native verification and signing/notarization status.

No VPN protocol, credential schema or system proxy changes. Pending governance/modularization candidates are excluded. School MFA remains user-driven; synthetic tests do not establish live-school acceptance.
