# 多设备连接 / Multi-device connections

Status: Current support boundary; campus concurrency unverified
Owner: Project maintainers
Last verified: 2026-11-05
Applies to: v2.0.6 / main `541091d7422132a98e0eca534f58e80c4f0fe931`; issue #287

## 能否同时连接两台 Mac？

不能仅凭客户端安装成功或两次单机登录成功保证双机并发。学校网关必须允许该账号或
映射用户组保持两个会话，并提供可用的 L3 资源及地址分配。客户端没有可绕过策略的
“多设备开关”，也不应同步 Cookie、token 或伪造设备身份。

深信服 [SSL M7.5 官方手册](https://www.sangfor.com/sites/default/files/download/SSL%20VPN%20User%20Manual%2075.pdf)
在 Local Users / Authentication Settings（印刷页 127）区分允许并发使用的 public user
与仅允许一次登录、后登录使前者下线的 private user。这是历史版本的厂商能力说明，
不是当前学校账号策略的证明；这里的 public 并不意味着公开密码。策略及 L3 地址配置
必须由管理员按实际版本确认，不建议用户自行修改账号属性。

此前协议说明中的“Multiple concurrent clients: disabled”缺少可对应的保留字段和
账号策略证据。它不能与“同一电脑运行多个网关客户端”或“同账号跨设备并发”混为一谈。

## 当前客户端证据与限制

- 登录创建独立 HTTPS 会话及 Cookie store；运输层使用服务端返回的认证会话和 TLS
  会话材料。生产密码表单中未发现主动替换其他设备的参数。
- 客户端注销通过本次登录的会话发送；服务端是否把注销扩展到同账号其他会话仍需验证。
- 两个独立进程管理实例的启停、重连定时器和会话材料可用离线测试验证。
  这不等于验证了真实 Cookie 传输、服务端并发登录、地址分配或校园资源双机可达。
- 尚无经验证的服务端“被其他设备替换”原因码。普通超时、断网和通道关闭不能被擅自
  显示成“另一个设备已登录”。若获得稳定、脱敏的原因码，才可增加专用提示和停止抢占式重试。
- myPortal 登录过期属于浏览器 SSO 会话，与 VPN 并发策略不同。课表恢复不能证明
  VPN 双机连接已修复；课表修复独立跟踪于 #295 / PR #296。

## 不影响现有网络的排查顺序

1. 先记录两台应用版本、macOS 版本、是否同一账号，以及掉线发生在 B 登录时还是 B 退出时。
   不需要用户名、密码、验证码、Cookie、token、完整服务器地址或原始日志。
2. 请学校 IT 确认账号/用户组的有效并发限制、外部认证组映射、L3 权限及地址分配。
   如果只能保留一个会话，应由管理员批准策略调整或提供独立授权账号。
3. 仅在用户和管理员同意的测试窗口进行双机实测，避免中断 SSH、上传或其他正在运行的任务。
   先记录自动重连原设置；测试期间由用户暂时关闭两端自动重连，避免单会话策略下互相抢占。
   不修改 DNS、默认路由、Clash 或系统代理。
4. A 连接并读取一个授权校园资源 → B 连接 → 两端再次读取该资源 → B 断开 → 验证 A
   仍可读取；交换 A/B 重复。只记录时间、连接阶段、脱敏错误码和成功/失败。
5. 如果网关允许并发但失败，仅围绕失败阶段修复；不能把“已连接”标签作为资源可达证据。
   如果不允许并发，保持一端断开，不反复强制登录。测试后由用户恢复原重连设置。

## English summary

Simultaneous two-Mac access is **not yet campus-validated**. It requires the
gateway's effective account/group policy and L3 address allocation to permit two
sessions. Vendor public/private account terminology documents a capability, not
this campus's policy. There is no client-side policy bypass or token-sharing mode.

The client creates per-login HTTPS sessions and derives channel material from
server-issued session inputs. Offline owner/token tests do not prove server-side
logout scope or two-device resource access. Generic transport failures must not be
relabeled as session replacement without a verified gateway reason code.

Request versions and sanitized event timing first, then administrator policy
confirmation. An explicitly agreed test window should cover A→B, B→A, concurrent
resource reads, and disconnect-one/preserve-the-other. Record and temporarily
disable automatic reconnect only with user agreement to avoid repeated takeovers;
restore it afterwards. Do not change system networking, share credentials or
publish raw authentication/network captures. Portal SSO expiry is tracked separately.
