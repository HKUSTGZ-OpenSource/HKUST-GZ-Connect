# ADR-0037：断网后的持续自动恢复

- Status: Proposed
- Owner: project maintainers
- Last verified: 2026-10-09
- Applies to: Desktop 连接状态机、Engine 密码认证网络错误；尚未进入 2.0.3 安装包

## 问题与决定

密码登录请求的超时、连接重置和响应中断被统一转换为 `AUTH_INDETERMINATE`，
Desktop 因此取消用户连接意图。网络恢复事件无法再恢复该意图；三次短期重试耗尽
同样会导致永久停止。断网时注销无法确认，也可能阻止已关闭进程后的恢复。

保留 HTTP 网络错误的类型，并通过新增的 `AUTH_NETWORK_UNAVAILABLE` 事件传给
Desktop。`AUTH_INDETERMINATE` 继续表示无法归类的认证错误，不自动重试。
明确的密码拒绝、不支持的 MFA、协议、配置和本机资源错误继续停止自动重试。

`AUTH_NETWORK_UNAVAILABLE`、`GATEWAY_PRELOGIN_UNAVAILABLE`、`DATA_PLANE_SETUP_TRANSIENT`、`NETWORK_DISCONNECTED`
及 `network_unhealthy` 采用持续网络恢复策略：短期按 5/10/15 秒退避；预算耗尽后
每 30 秒重试，计数饱和，保留同一连接意图。`maxAttempts = 0` 或关闭自动重连
仍禁止重试。其他故障保留原有有界预算。

在已经暂停的断网/休眠恢复路径中，旧 Engine 的权威 `close` 是本机重启屏障。
远端注销失败不证明旧进程仍占用本机资源，不再单独取消恢复意图。旧进程无法关闭
仍阻止新进程启动；普通手动重连、Profile 切换等路径保留原来的清理要求。

## 安全、兼容与回滚

POST 失败后仍先尝试有界注销，保留 `AUTH_CLEANUP_UNCONFIRMED` 次级证据。
网络不可达时可能无法确认服务器端会话是否已注销；下一次尝试创建独立会话，
重新认证，不复用旧 Cookie，也不宣称上次认证成功。风险是网关短期保留旧会话；
持续尝试可能增加密码登录请求，因此使用低频退避，并在明确拒绝时立即停止。
不自动提交 OTP、不改变 TLS 校验、凭据存储、系统路由或校园浏览器阻断策略。

手动断开、退出、关闭自动重连以及 intent/generation 退休仍使旧工作失效。
只有新一代认证、隧道、监听端口及浏览器屏障就绪后才能发布“已连接”。
Event API v1 新增稳定错误值，不更改字段；旧 Desktop 将其作为未知错误处理，
故 Engine 与 Desktop 应成套升级。回滚该变更可恢复原先有界重试行为，无数据迁移。

## 验证边界

使用合成网络故障、状态机测试、事件序列化测试及真实 Electron Main/子进程测试
验证超过短期预算、网关恢复、重复断网、手动断开和旧工作无效。不将离线测试
表述为学校网关、真实休眠唤醒或全部平台安装包验收。
