# HKUST(GZ) Connect 2.0.1

- Status: release candidate; publish only with matching verified artifacts
- Owner: HKUST(GZ) Connect maintainers
- Last verified: 2026-09-07
- Applicability: Windows x64, Linux x86_64, macOS arm64/x64

## Windows 登录页卡顿修复（#97）

2.0.0 在 Windows 上反复同步启动 PowerShell 检查持久化文件权限。设置、账号显示状态、收藏和分组的刷新重复读取文件，阻塞 Electron 主进程，表现为登录页长时间转圈、输入和按钮迟迟没有响应。

- 展示刷新复用已验证的设置、收藏、最近访问和分组快照；写入后失效并刷新缓存。连接时读取凭据、持久化写入和显式刷新仍通过实际存储权限与归属校验。
- Windows 安装包包含小型原生权限组件，通过 Win32 文件句柄检查和设置当前用户专属 DACL，避免启动时重复加载 PowerShell。组件拒绝目录、重解析点和硬链接；收紧旧文件权限前检查归属，拒绝后不会转用另一实现放行。

5070 Windows 合成工作区复测中，主窗口启动约从 17 秒降至 1.8 秒；连续状态查询没有启动权限子进程，登录输入框可编辑。耗时取决于设备和工作区，并非对所有电脑的性能承诺。

## 更新渠道与依赖

- 保留 main 已合入的更新渠道修复：通过不可变 GitHub repository ID 发现当前 owner，并验证规范 API 和 Release URL，支持后续仓库转移。
- 包含 main 中的 Rust 依赖安全更新（包括 time 0.3.47）。
- 不改变校园网关协议、MFA 能力、路由策略或用户数据格式。

## 升级与验证

保留设置、收藏、分组、校园浏览器数据和安全保存的凭据。Windows/Linux 验收在 5070 完成，使用临时合成工作区；未使用真实校园账号。回归覆盖登录响应、1.2.3 数据迁移、学校新增/切换、网络恢复、浏览器路由/MFA/布局、渲染器恢复、空闲性能和原生权限边界。

旧版迁移测试先让独立写入进程正常退出，再启动新版，覆盖 Windows 加密配置的实际落盘与重新加载。macOS 只构建和校验安装包，本次未重新执行 macOS 功能测试。附件源码提交、签名状态和 SHA-256 以 Release 构建收据为准。

## Downloads

- macOS Apple Silicon: `hkustgzconnect-2.0.1-mac-arm64.dmg`
- macOS Intel: `hkustgzconnect-2.0.1-mac-x64.dmg`
- Windows x64: `hkustgzconnect-2.0.1-win-x64.exe`
- Linux x86_64: `hkustgzconnect-2.0.1-linux-x86_64.AppImage`

## English summary

Fixes the Windows login freeze caused by repeated synchronous PowerShell ACL checks. Display updates reuse validated snapshots, invalidated after mutations. A bundled Win32 helper checks and applies private permissions without PowerShell startup, preserving current-user ownership and rejecting reparse points and hardlinks. Credential access and writes still validate storage authority. Includes repository-transfer-aware update discovery and Rust dependency security updates. Windows/Linux acceptance runs on 5070; macOS receives package builds and verification only. Release receipts record artifact provenance and signing status.
