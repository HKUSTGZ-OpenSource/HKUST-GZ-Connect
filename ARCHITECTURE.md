# HKUST(GZ) Connect 项目架构宪法

状态：Normative

适用范围：Rust Engine、Electron Desktop、命令行入口、测试、CI、构建与兼容研究。

本文定义长期有效的工程边界。版本路线、功能状态和一次性审计结论分别记录在
[`ROADMAP.md`](ROADMAP.md)、[`docs/engineering/`](docs/engineering/) 和
[`docs/audits/`](docs/audits/)；它们不得反向放宽本文的安全与依赖约束。

## 1. 工程目标

项目按以下顺序取舍：

```text
Correctness
  > Stability
  > Maintainability
  > Security
  > Observability
  > Performance
  > Features
```

“1.0 工程收束”在本仓指 1.x 产品线的架构冻结基线，不要求把已经发布的版本号倒退。
未经证据支持的 EasyConnect 能力不得因为存在类型、trait、fixture 或 UI 占位而被宣称
可用。

## 2. Repository layout

| 路径 | 职责 | 禁止承担 |
| --- | --- | --- |
| `independent/src/engine/` | 生产 Engine 领域和应用层：认证事务、会话、Transport、Data Plane、netstack、DNS、本地 proxy | Electron UI、系统全局网络配置、兼容性探测工作流 |
| `independent/src/bin/ec-engine.rs` | 生产 Engine composition root、信号与进程级资源装配 | 新协议解析、UI 文案、平台 GUI 策略 |
| `independent/src/{gateway_http,gateway_auth,modern,special_tls11}.rs` | 经验证的 Gateway HTTP、认证产物和传输协议实现 | Desktop 状态、凭据落盘、系统代理 |
| `independent/src/{watch,probe,adapter,protocol_map,binary_watch}.rs` | 授权、脱敏、非生产兼容实验室 | 生产连接路径和发布能力声明 |
| `independent/tests/` | 跨模块 contract、fault、fixture 和进程集成测试 | 真实凭据、真实 Cookie/token、厂商二进制 |
| `desktop/main.js` | Electron composition root | 长期业务状态、协议解析、密码处理算法、复杂 IPC 业务 |
| `desktop/lib/` | Desktop application/domain services 和窄基础设施适配器 | Renderer DOM、Rust wire layout 的重复实现 |
| `desktop/renderer/` | 展示与用户交互 feature | 文件系统、child process、Gateway/Engine secret、底层 socket |
| `desktop/preload.js`、`campus-preload.js` | 有界、类型化、最小权限 IPC/页面桥 | 通用 Node 能力、任意 channel、Gateway 内部状态 |
| `desktop/test/`、`desktop/e2e/` | Desktop unit/contract 和真实 Electron E2E | 生产构建资源 |
| `desktop/build/`、`desktop/scripts/` | 打包验证和维护脚本 | 生产运行时业务逻辑 |
| `docs/architecture/` | 跨版本目标架构 | 当前能力完成声明 |
| `docs/engineering/` | 1.x 审计、收束计划和 release gate | 协议事实原始证据 |
| `docs/adr/` | 重大且难以逆转的工程决策 | 临时实现笔记 |
| `independent/spec/` | Engine wire/Provider/compatibility 规范 | UI 实现细节 |

不要为了目录外观移动稳定代码。只有职责、生命周期、协议、平台实现或测试边界独立时
才拆分模块。

## 3. 依赖方向

生产依赖必须保持单向：

```text
Desktop Renderer
  -> bounded Preload API
  -> Desktop application coordinators
  -> Engine supervisor + private Event/Control protocol
  -> Rust process composition
  -> Authentication
  -> AuthenticatedGatewaySession
  -> TransportBackend
  -> Data Plane
  -> VirtualNetstack
  -> DNS / SOCKS / HTTP frontends
```

基础设施适配器由 composition root 注入领域/应用服务。禁止：

- Renderer 直接操作 socket、文件、child process 或安全存储；
- IPC handler 自己形成第二套 application layer；
- Authentication 控制系统代理、DNS、route 或浏览器；
- Transport 读取磁盘凭据或依赖 Desktop；
- DNS、SOCKS、HTTP frontend 反向依赖认证 provider；
- compatibility laboratory 进入生产 Engine 数据路径；
- UI 复制 Rust 协议解析规则或依据英文 stderr 推断状态。

## 4. Domain ownership

### 4.1 Authentication

负责：

- Password 和未来 evidence-gated provider 的统一状态模型；
- challenge、transaction、epoch、request、deadline 和预算；
- secret 输入的有界、内存化、zeroizing 生命周期；
- 产出 `AuthenticatedGatewaySession` 或稳定失败。

生产 provider 选择由闭合、编译期 `ProductionProviderSet` 统一装配。Profile 只能选择已编译
`ProtocolFamily`；不能通过 JSON 加载任意实现。能力报告以 compiled/provider/profile/ingress
四层相交，任何后续层只能收紧，不能提升缺失能力。详细合同见
[`ADR-0006`](docs/adr/0006-production-provider-composition.md)。

绝不负责：

- L3、DNS、SOCKS、PAC、浏览器路由；
- Renderer 状态；
- 未观察到的 endpoint、字段、OTP 长度或渠道映射。

### 4.2 Session

负责认证完成后的 HTTPS Cookie jar、opaque session identity、logout 和会话清理。
Session 不拥有 L3 token、Data Plane、DNS resolver 或本地 proxy。

### 4.3 Transport

只消费已经认证的 Session，负责配置、Modern token、证书绑定和 Data Plane 装配。
Transport 失败不得重新解释用户名、密码或 challenge。

### 4.4 Network core

- Data Plane：Gateway channel 和 IPv4 packet transport；
- VirtualNetstack：用户态 TCP/UDP socket；
- DNS：只通过选定校园 resolver 和 VirtualNetstack 查询；
- Proxy frontend：SOCKS5、HTTP CONNECT、普通 HTTP/WS 的有界本地入口；
- Routing：Desktop 内部浏览器/PAC 的域名策略，不修改系统 route。

Network core 不依赖 Desktop、凭据存储或具体认证方法。

### 4.5 Desktop

Desktop 负责用户意图、Engine 进程、浏览器、设置、安全存储、托盘和展示。它只消费
稳定的 Engine event/error code，不持有 Gateway Cookie、TwfID、CSRF、Modern token、
transport token 或原始认证响应。

`desktop/lib/network-environment/` 独立拥有跨平台网卡/路由观测。公网出口探测只能由 Main
使用代码内固定的 HTTPS endpoint、绑定候选本机源地址并在内存中短时缓存；Renderer 不得提供
endpoint、源地址或请求头。该结果仅表示外部服务对一次请求观测到的出口，不能推导“已代理”或
“直连”，不得写入设置、日志、telemetry 或持久化状态，也不得进入连接成功与否的判定路径。

### 4.6 Profile / Account / Workspace storage

持久用户状态按 `SchoolProfile -> CampusAccount -> WorkspaceScope` 归属。路径只能由安装本地生成的
opaque `profileKey` / `accountKey` 派生；Profile ID、Gateway、用户名、标签和 Renderer handle
不得成为路径组件。Browser partition 只能由 `workspaceKey` 的稳定摘要派生；现有
`persist:hkustgz-campus-browser` 仅允许经 HKUST primary 的 P3 迁移 journal 显式收养。

迁移必须先建立 owner-only、no-follow、single-link 的 journal，并保持单调
`prepared -> committed -> cleared`。journal 只能保存身份/版本绑定和有界 SHA-256 收据，不保存
用户名、密码、Cookie、token 或旧文件内容。`prepared` 不得覆盖或删除；commit 必须保持同一
Profile/origin/family/key/source binding 并采用同目录临时文件、文件 fsync、原子 rename、目录
fsync。Windows 文件还必须在提交前后通过 current-user-only DACL 保护与验证。

P3 完整激活前，flat 1.x `userData` 仍是唯一生产权威；基础 layout/journal 模块不得由
`desktop/main.js` 导入。详细合同见 [`ADR-0007`](docs/adr/0007-p3-storage-foundation.md)。

旧 flat 状态的迁移收据必须由同一个 no-follow descriptor 完成 `fstat -> bounded hash -> fstat`，
同时比较 inode、size、mtime、ctime；收据只含 `present / bytes / sha256`。VPN username 与 password
必须作为一个加密 envelope 提交，并绑定 profile/account credential revision、Gateway origin、
ProtocolFamily 和 credential version。解密结果由 Main-only zeroizing owner 管理，不进入 Renderer、
日志或 migration journal。详细合同见 [`ADR-0008`](docs/adr/0008-p3-receipts-and-vpn-envelope.md)。

迁移协调器是同步、single-flight 的 Main-domain service。无 journal 时新旧权威并存必须阻断；
`prepared` 只能在旧 source receipts 完全一致时幂等续跑；`committed` 只能在 destination receipts
完全一致时退休旧权威并清 journal。异常不得把 prepared 降级为 absent，也不得在未验证
destination 时删除 legacy。生产接线前的非激活合同见
[`ADR-0009`](docs/adr/0009-p3-migration-coordinator.md)。

destination materializer 必须在第一次写入前预检全部 exact-schema target；已存在且 digest 相同可幂等
复用，任何冲突、link、宽权限或未知文件都不得覆盖。legacy retirement 只能在 committed journal
下重新验证收据后逐文件 unlink/fsync，禁止递归删除，并把旧 `settings.json` 权威放在最后退休。
具体非激活适配器合同见 [`ADR-0010`](docs/adr/0010-p3-destination-and-retirement.md)。

HKUST destination planner 必须从 receipt-matched legacy settings/payload 与同一 username/password owner
构造 exact destination plan。全局、Workspace 和更新状态分离；VPN 凭据作为绑定 envelope；旧 ciphertext
只能进入 account-scoped 一代 rollback blob，并由 `active | retired` 元数据绑定 migration/Profile/
Account/origin/family。目标 JSON 不得保存 username/password。合同见
[`ADR-0011`](docs/adr/0011-p3-hkust-destination-plan.md)。

## 5. Connection state machine

### 5.1 唯一权威状态

1.x Architecture Frozen 以后，Desktop 的连接相位必须只有一个可变权威来源。
`connected`、`connecting`、按钮状态、托盘状态和自动恢复条件必须从同一 snapshot 投影，
不得通过多组独立布尔值组合推断。

一个 snapshot 至少包含：

```text
phase
intent
desiredConnected
engineGeneration | null
attempt
lastOutcome | null
wasConnectedBeforeStop
connectedUptimeBeforeStop
```

其中：

- `intent` 使旧的异步 continuation 失效；
- `engineGeneration` 使旧进程、探测和事件失效；
- `lastOutcome` 是稳定 error/reason，不是另一个隐式状态；
- stop context在撤销serving权限前捕获，用于close阶段正确决定稳定会话重试预算和文案；
- UI presentation 是纯函数，不得反向修改状态机。

### 5.2 标准相位

| Phase | 含义 | 允许持有的主要资源 |
| --- | --- | --- |
| `idle` | 无活动 Engine，未计划自动连接 | 设置、加密凭据、持久 Browser Session |
| `starting` | 已接受连接意图，正在取得最终设置快照并启动 Engine | 一次 connect operation、最终凭据快照 |
| `authenticating` | 当前 generation 正在 Gateway 认证 | Engine child、private control、认证 worker/session |
| `preparing_tunnel` | 已通过认证，正在配置 L3/Data Plane/DNS/listener | authenticated session、transport setup |
| `connected` | Data Plane 和预期 loopback listener 已就绪 | Engine、proxy credential projection、telemetry、Browser gate open |
| `retry_wait` | 当前 generation 已关闭，等待有界重试 | 一个 generation-bound timer，不得持有旧 Session/socket |
| `connectivity_paused` | suspend/offline 已使旧 generation 失效，等待恢复条件 | 用户连接意图；不得持有可用旧网络资源 |
| `stopping` | 停止流程拥有 child，等待 control/signal/close | 一个 shared stop flight；Browser gate 必须关闭 |

不可恢复或已耗尽的失败最终进入 `idle` 并保留 `lastOutcome`。不要建立会永久占有资源的
模糊 `failed` 状态。

### 5.3 事件与转换

所有转换必须由 allowlist 执行；非法事件是 no-op 或 typed internal error，不能偷偷修正
成另一个状态。

```text
idle --connect_requested--> starting
starting --engine_authenticating--> authenticating
authenticating --authenticated/config_started--> preparing_tunnel
preparing_tunnel --listener_and_tunnel_ready--> connected

starting|authenticating|preparing_tunnel|connected
  --user_disconnect--> stopping

starting|authenticating|preparing_tunnel|connected
  --suspend_or_offline--> connectivity_paused

starting|authenticating|preparing_tunnel|connected
  --unexpected_close_retryable--> retry_wait

retry_wait --retry_timer_current--> starting
connectivity_paused --network_resumed_current--> starting
stopping --owned_child_closed--> idle|starting
```

`connected` 只能在同一 generation 同时满足 Engine connected candidate、正确 listener port
和 Browser request gate 安全切换后成立。Browser 激活失败可以留下“隧道已连接但浏览器
不可用”的结构化 degraded outcome，不能伪造网络断开。

### 5.4 Engine 与 Desktop 状态映射

Engine Event API 是事实输入，不是 Desktop FSM 的替代：

- Engine `connecting` -> Desktop `starting`；
- Engine `authenticating` -> Desktop `authenticating`；
- authenticated/L3 setup evidence -> Desktop `preparing_tunnel`；
- Engine `connected` 加 listener barrier -> Desktop `connected`；
- Engine `stopping/stopped` 只在 generation 匹配时推进停止/关闭结果。

stderr 只用于脱敏诊断，不允许驱动状态转换。

## 6. Resource lifecycle

| 资源 | 唯一 owner | 创建 | 终止条件 | 完成证据 |
| --- | --- | --- | --- | --- |
| Engine child | `EngineSupervisor` | `start()` | graceful control、signal、force deadline | authoritative `close` |
| Retry timer | `EngineSupervisor`/recovery coordinator | retry decision | generation invalidation、执行、dispose | timer record removed |
| Auth transaction | Rust `AuthTransactionOwner` | provider challenge | authenticated、cancel、expiry、budget、drop | exactly-once provider cleanup |
| Auth blocking worker | Rust auth lifecycle coordinator | password flow | result、shutdown、pipe EOF、deadline | worker joined or late session logged out |
| Gateway Session | Rust Session layer | auth success | Transport ownership transfer、failure、shutdown | bounded logout/cleanup status |
| Data Plane | Rust connection object | Transport success | unhealthy、shutdown、drop | send/receive bridges stopped |
| SOCKS/HTTP listener | Rust process assembly | tunnel ready | Engine stop/unhealthy | accept task ends and port released |
| Client tasks | SOCKS frontend `JoinSet` | accepted local client | EOF、timeout、shutdown | task drained/aborted |
| DNS query | resolver/singleflight owner | cache miss | first valid result、deadline、drop | slot released, no failed cache entry |
| Proxy plaintext projection | Desktop current generation | before Engine spawn | stop、generation change、quit | file removed and buffer destroyed |
| Browser request gate | Browser session manager | Browser creation | Engine exit/suspend/switch | fail-closed PAC active |
| Telemetry | generation-bound coordinator | stable connection | stop/hide policy/generation change | timers and collectors disposed |

资源清理不能依赖 UI 仍然存活。`exit` 与 `close` 必须区分：前者立即关闭 Browser 请求
边界，后者才释放 child ownership。

## 7. Error model

错误分三层：

```text
Infrastructure/Protocol Error
  -> stable Domain/Application ErrorKind
  -> localized User-facing Outcome
```

规则：

1. 生产控制流不得解析英文错误字符串。
2. 明确拒绝、结果不确定、协议非法、资源耗尽、取消和清理未确认必须可区分。
3. secondary cleanup failure 不得覆盖 primary failure。
4. retryability 由稳定 kind/code 定义，不由文案或 exit code 猜测。
5. 新增生产路径不得返回 `Unclassified`；旧路径在触及时渐进迁移。
6. 用户只看到可行动、不过度归责的信息；日志保留脱敏 source chain。
7. `unwrap`/`expect` 只允许测试或已经由同一函数证明不可失败的内部不变量，并应有说明。

## 8. Logging and observability

每次连接应有本地、无秘密的 correlation identity，至少能关联：

- Desktop lifecycle intent；
- Engine generation；
- state transition；
- attempt/reconnect count；
- stable failure kind；
- DNS source mode；
- Browser/Proxy readiness；
- stop reason。

禁止记录：password、OTP、Cookie、token、CSRF、完整认证响应、完整敏感 URL、校园目标
查询参数或本地 proxy password。

日志必须异步、有界、轮转和按期限删除；读取诊断只读固定尾部。可观测性失败不得阻塞
连接核心，也不得被静默当作业务成功。

## 9. Async and concurrency rules

- 所有跨 `await` 的结果必须重新验证 intent/generation/epoch；
- 同一资源只允许一个 owner 和一个 terminal completion；
- connect、stop、reconnect、routing transaction 和 save prompt 必须 single-flight 或串行化；
- timer 必须可取消并在 dispose 后 inert；
- 不允许无 owner 的 detached task；
- blocking Gateway 操作必须放在可取消的 worker/coordinator 后；
- timeout 是总 deadline，不得让每一步重新获得完整预算；
- shutdown 顺序必须先关闭新请求入口，再取消工作，最后释放资源。

## 10. Security invariants

- Gateway TLS、Browser TLS 和证书 pin 均 fail-closed；
- vendor TLS 兼容实现只用于经验证的窄通道，不能成为通用 TLS；
- 本地 listener 只绑定 loopback；
- 桌面新安装默认兼容本地 proxy，严格认证可手动开启；保留已有明确设置；
- Renderer 不得取得 VPN/Proxy secret；
- POSIX私有文件采用原子写入、no-follow和owner-only mode；Windows明文proxy helper
  sidecar必须关闭继承、设置current-user-only DACL并回读验证；其他profile-scoped私有文件
  目前主要依赖用户profile ACL，不得表述为已有逐文件DACL验证；
- macOS发布包中的Rust Engine/SSH helper只能链接`/usr/lib`或`/System/Library`系统库；
  第三方C依赖必须静态链接，package verifier必须对两种架构执行真实`otool -L`门禁；
- Campus Browser sandbox、context isolation、无 Node integration、拒绝设备权限和本机服务；
- 不修改系统 DNS、默认 route 或全局 proxy；
- 不提供 public DNS fallback；
- Chromium `DIRECT`只承诺文本目标预检，不承诺解析后地址隔离；1.x风险边界见ADR-0002；
- unknown/unsupported auth、route、protocol state fail-closed；
- 第一方Rust crate的所有target必须由Cargo lint `forbid(unsafe_code)`；若未来确有不可替代
  的平台需求，必须先以独立ADR收窄模块、证明边界并修改该全局门禁；
- test CA、fake gateway、fixture 和厂商 artifact 不得进入发布包。

## 11. Platform isolation

共享领域代码不得包含散落的平台分支。平台差异应位于明确适配器中，例如：

- private-file/DACL；
- child ownership cleanup；
- credential store；
- packaging/signing；
- future underlay socket binding。

平台适配器必须有 contract test；声称跨平台完成还需要对应平台的真实 CI 或设备证据。
在 macOS 上 mock Windows API 不等于 Windows 已验证。

## 12. File placement and splitting

拆分的正当理由：

- 独立生命周期；
- 独立协议/codec；
- 独立状态机；
- 独立平台实现；
- 能形成稳定测试 seam；
- 当前文件已混合三项以上不同职责。

不正当理由：行数本身、一个函数一个文件、只有一个实现却建立多层 wrapper。

新增职责前的默认规则：

- `desktop/main.js` 只装配，不增加长期业务状态；
- `renderer/app.js` 不增加可独立测试的 feature；
- `ec-engine.rs` 不增加协议 codec；
- `socks.rs` 不增加与 frontend 无关的 policy/transport；
- `dns.rs` 的 wire 和 transport 在复杂度增长时独立；
- 新 trait 必须解决第二实现、真实测试替身或平台隔离问题。

命名应表达领域和 owner，避免 `utils`、`common`、`helper` 黑洞。

## 13. Testing architecture

逻辑分层而非机械目录分层：

| 层级 | 证明内容 |
| --- | --- |
| Unit | 纯函数、状态转换、bounds、redaction |
| Protocol | request/response codec、fragmentation、malformed input、stable code |
| Lifecycle | owner、cancel、timeout、generation、exactly-once cleanup |
| Integration | auth + session + transport、Engine/Desktop private pipe |
| Fault injection | reset、partial body、timeout、DNS failure、proxy unavailable、renderer/process loss |
| Electron E2E | sandbox、IPC、Browser Session、popup/SPA、真实 Chromium proxy |
| Package | 精确源码拓扑、native 架构、fixture 排除、外部动态库闭包、启动 smoke |
| Real canary | 学校 Gateway、校园 DNS、sleep/wake、network switch、目标资源 |

历史 P0/P1 修复必须进入 regression suite。Synthetic 测试只证明其覆盖的边界，不能替代
真实 Gateway、目标Windows文件类别的DACL、签名或学校资源 canary；当前真实DACL门只覆盖
明文proxy helper sidecar。

`independent`的非默认`engine-lifecycle-fixture`只用于真实`ec-engine`进程的有界重复
post-Transport生命周期soak。它使用无外部路由的packet transport，强制DNS disabled，
并带固定package-rejection marker。所有发布构建必须显式`--no-default-features`；
electron-builder的`afterPack`必须在签名前拒绝该marker，独立package verifier在打包后
再次拒绝。这个测试接缝不构成真实Gateway认证、Modern L3、Gateway logout或校园流量证据。

## 14. Documentation and ADR

必须写 ADR 的事项：

- 新系统权限或常驻服务；
- TUN、route/DNS 注入、system proxy；
- 新公开/本地 listener；
- 新认证秘密存储；
- underlay/interface binding；
- 协议版本破坏性修改；
- 引入厂商组件或许可证边界变化。

ADR 至少记录 Context、Decision、Alternatives、Consequences、Security、Rollback、Evidence。
协议研究必须区分 `Observed`、`Confirmed`、`Hypothesis`、`Unknown`。

## 15. Change and release rules

每个变更批次必须：

1. 说明问题和当前证据；
2. 限定修改与非修改范围；
3. 增加匹配风险的测试；
4. 通过相关回归和 architecture/secret gate；
5. 记录兼容性、安全影响和回滚；
6. 使用可审查、可独立验证的 commit；
7. 不把多个高风险领域塞入同一批。

完成定义以 [`docs/engineering/1x-release-gate.md`](docs/engineering/1x-release-gate.md)
为准。CI workflow 存在不等于 CI 已运行，绿色 build 不等于真实网络功能已验证。

## 16. Enforcement

当前自动门包括 Rust fmt/Clippy/tests、Desktop tests、CommonJS cycle/growth ratchet、精确
Git tree secret scan、Electron E2E 和 package verifier。后续门应优先验证依赖方向和状态
单一来源，而不是只增加行数限制。

违反本文的变更必须通过 ADR 说明为什么旧约束不再正确；不得在普通 feature commit 中
悄悄放宽。
