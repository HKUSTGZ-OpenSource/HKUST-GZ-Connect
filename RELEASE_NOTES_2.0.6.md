# HKUST(GZ) Connect 2.0.6

- Status: Release candidate; maintainer accepted local connection test and authorized publication
- Owner: project maintainers (Windows/WSL primary; Mac native validation/packaging)
- Last verified: 2026-11-05
- Applies to: 2.0.6 candidate based on main `77c7498b4a93bdbab61d500c10271674786ddbc0`
- Tracking: #293; final tag, build and artifact evidence belong to the release receipt

## 中文

- 修复港科广 VPN 域名在内网解析时被误拒绝连接的问题。只为已审核的学校配置启用现有内网网关策略，不硬编码本机 IP；未知学校、危险地址、混合地址集合与 TLS 证书检查保持原有安全边界。
- 网关地址策略拒绝现在显示独立、可操作的提示，不再笼统建议“恢复默认或重装”。该类失败继续停止自动重试。
- 修复浏览器窗口关闭或替换后，排队的证书确认请求可能交给新窗口处理的问题；失去原页面归属的请求会被拒绝。
- 同步桌面端、命令行配置与完整性摘要，保留现有账号、收藏和浏览器数据。

维护者已确认本地 Mac 2.0.6 测试包可以连接。此反馈不代表所有学校、所有网络或每个校园资源都完成验收；安装包、平台测试和签名状态以正式构建回执为准。

Dock“App／应用”列表未显示应用的本机报告仍单独调查，不将 Spotlight 元数据可检索等同于应用列表界面已恢复，也不宣称本版已修复该系统搜索问题。

## English

- Support private resolution of the reviewed HKUST(GZ) VPN gateway through the existing school-specific policy exception, without hardcoding a machine address or weakening unknown-school, forbidden/mixed-address or TLS validation.
- Report gateway address-policy rejection explicitly instead of suggesting reinstalling. These failures remain terminal for automatic retry.
- Bind queued Browser certificate consent to the original Browser/page owner; reject requests after that owner is retired or replaced.
- Keep Desktop/CLI configuration integrity bindings synchronized and preserve existing user data.

The maintainer accepted connectivity with the local Mac candidate. This is not universal gateway/resource acceptance. Native build/package/launch results and signing status are recorded separately. Local Dock Apps search visibility remains an independently tracked issue, not a claimed release fix.
