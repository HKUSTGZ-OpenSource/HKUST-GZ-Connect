# HKUST(GZ) Connect 2.0.3

Status: Release candidate — publication and exact artifact acceptance are recorded in the GitHub Release.
Owner: project maintainers
Last verified: 2026-09-26
Applies to: 2.0.3

## 中文

- 修复浏览器下载在 100% 时仍停留在进行中状态的问题：在原生保存动作前注册完成事件，保留快速下载的完成、取消和失败反馈。
- 区分提交密码前的网关访问失败与提交后的登录结果不确定；前者使用对应的网络错误提示和安全重试策略，不再一概显示“登录结果无法确认”。
- 修复切换账户或关闭旧浏览器后，旧下载、分类整理、收藏和页面加载的异步结果继续更新新窗口或抢走焦点的问题。
- 修复外部工具配置导出后的状态反馈和按钮焦点保持；仍需用户主动保存或导入配置，应用不会修改第三方软件。
- 收紧连接页的小窗 IP、延迟卡片布局，减少空白；保留复制、延迟趋势和连接开关。
- 完善校园数据、收藏、认证弹窗、浏览器标签和工作区的独立生命周期，降低互相干扰的风险；加强模块归属、升级兼容和原生弹窗回归检查。
- 更新经过兼容性验证的 Rust 依赖。保留 Electron 43，不在补丁版本中引入 Electron 44 的旧平台支持变化。

本次不修改系统代理、DNS 或默认路由，不引入新的校园业务或凭据迁移。
Windows 登录报告 #127 尚无原始故障的脱敏复现证据；本版本包含相关错误分类修复，但不声称所有 Windows 登录问题已解决。
完整模块化和组织治理任务仍在继续，不以发布版本代替 issue 验收。真实学校登录和 MFA 不由离线测试推定。

## English

- Register native download completion before save starts, fixing downloads that remain in progress at 100%, including fast completion, cancellation and failure paths.
- Distinguish Gateway failures before password submission from indeterminate results after submission, with appropriate network messages and safe retry behavior.
- Prevent retired download, category, favorite and page-loading callbacks from updating or stealing focus from a replacement Browser after account/context changes.
- Preserve Integration Center export feedback and action focus. Saving/importing remains explicit; third-party software is not modified.
- Compact the IP and latency metrics at narrow widths while retaining copy, trend and connection controls.
- Isolate campus data, favorites, authentication dialogs, Browser tabs and Workspace lifecycle ownership and strengthen upgrade/native-popup regressions.
- Update validated compatible Rust dependencies; retain Electron 43 rather than changing older-platform support in a patch release.

No global proxy, DNS, default-route or credential migration changes. Windows report #127 still needs evidence for its original failure; this patch does not claim to resolve every Windows login problem. Full modularization/governance remains ongoing. Offline fixtures are not live-school or MFA acceptance. Consult the release receipt for exact packages and actual signing/notarization status.
