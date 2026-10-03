# HKUST(GZ) Connect 1.2.3 baseline and roadmap

- Status: Current implementation/evidence ledger with historical 1.x baselines
- Owner: project maintainers
- Last verified: 2026-10-03
- Applies to: immutable stable v2.0.3 and separately verified development main; see
  [current status](docs/2.0-status.md) for exact source identities

This roadmap is an implementation and evidence ledger, not a promise that an
unobserved proprietary gateway revision will work forever. A trait, parser,
capability marker, mock, or sanitized fixture is useful preparation, but it is
**not** a finished user feature.

## Status and evidence rules

Capability state has two independent axes. Do not collapse them into one
ambiguous `Done` label.

- **Implementation**: `I0` absent, `I1` type/interface, `I2` offline or
  synthetic, `I3` production-wired, `I4` multiple production providers.
- **Evidence**: `E0` none, `E1` source/contract review, `E2` unit/synthetic,
  `E3` packaged/cross-platform integration, `E4` authorized HKUST canary, `E5`
  same-profile official-client parity.

A proprietary Gateway capability is user-supported only when it is production
wired and has the real-environment evidence that the capability requires. A
current-tree `I3/E2` result is not upgraded by an older release canary without
an explicit compatibility review.

The compatibility matrix in `independent/spec/COMPATIBILITY_MATRIX.md` remains
the detailed evidence record. If this roadmap and that matrix disagree, use the
more conservative status until the discrepancy is reviewed.

## Release 1.2.3 baseline

正式交付：PR #5 merge commit与tag source均为
`5d8323d37de7c279ae70b3ec646f93791d6a3581`；main CI run `32630023985`和
tag build/release run `32630322732`均成功。Release包含macOS arm64/x64 DMG、Windows
x64 EXE和Linux x64 AppImage。学校真实canary与Architecture Frozen开放项继续按
[`docs/engineering/1x-release-gate.md`](docs/engineering/1x-release-gate.md)追踪。

| Area | Implementation | Current evidence | Production result and remaining evidence |
| --- | --- | --- | --- |
| Independent password + modern L3 engine | `I3` | Current tree `E2`; earlier restricted canary is historical evidence | Rust owns auth, tunnel, userspace TCP/UDP and loopback proxying; repeat an authorized canary after Gateway/client changes |
| Isolated Campus Browser | `I3` | `E3` package/synthetic Electron; current release campus-site canary pending | Multi-tab, direct/campus routing, local vault and fail-closed policy; repeat campus-site/partner SSO canaries |
| SOCKS/PAC/Clash/SSH frontends | `I3` | Current tree `E3`; Windows sidecar DACL and three-platform package passed | Desktop compatibility/optional authentication is the default; strict authentication remains explicit, existing choices are preserved, raw Engine and macOS CLI retain distinct defaults, no global mutation; obtain exact-SHA real Clash/SSH evidence |
| Authentication correctness | `I3` for password; `I2` generic challenge framework | Current `E2`; real Gateway MFA `E0` | Typed outcomes, stale-cancel fix and Engine budgets exist; real provider remains unsupported |
| Lifecycle and recovery | `I3` locally converged | `E3`; real sleep/network canary pending | Auth/Transport cancellation, deterministic data-plane drain, Main E2E, a 100-round real-Engine non-routing post-Transport soak and exact-SHA packages exist; real-network evidence remains missing |
| Desktop performance | `I2/E2` measurement harness | Offline synthetic only | Establish supported-device and real campus-page baselines before enforcing product targets |
| Split-horizon campus DNS | `I3` | Current `E2`; exact-release HPC/TC canary pending | Authenticated sources are preferred, reviewed profile fills absence, matching TC retries same resolver; public/system fallback disabled |

### 1.2.3 authentication and DNS hardening

The Gateway protocol can publish split-horizon DNS in authenticated
`rclist.csp` resource policy or optional `conf.csp` fields. The 1.2.x line reads
both locations on every connection. Downloaded policy is authoritative when
present; the bounded reviewed deployment profile is selected only when both
locations are empty or unavailable. Which source a particular release receives
must be recorded by its authorized canary rather than inferred from an older
run. Queries travel
through `VirtualNetstack`, responses validate transaction ID and the exact
question, and only bounded A answers are cached. Version 1.2.3 adds
length-prefixed TCP to the same resolver only after a valid `TC=1` response.
Public/system fallback is disabled and no operating-system DNS setting or route
is changed.

Authentication now treats only a verified structured password-required state
as credential rejection. Timeout/reset/partial outcomes are indeterminate and
stop blind automatic retries; malformed structured responses are protocol
invalid. Remote cleanup status is secondary and never overwrites the primary
failure. Generic interactive transactions remain synthetic-only but are
bounded by Engine-owned monotonic deadlines, steps, submissions, resends and
continuation-request ceilings.

### 1.2.1 lifecycle and restart evidence

The lifecycle APIs have deliberately separate directions. Event API v1 is the
engine-to-supervisor bounded event stream. Control API v2 is an opt-in,
bidirectional protocol over the already inherited private stdin/stdout pipes;
it does not open a loopback control listener. Closing that stdin channel closes
control only and does not implicitly stop the tunnel. The current implemented
control capabilities are graceful engine shutdown, request cancellation, and
control-channel close. During authentication, losing the private pipe cancels
that generation; after connection, pipe EOF closes control only and leaves the
tunnel under process/signal supervision. Names for resource, WebVPN, or MFA capabilities return
typed unsupported errors and are not implementations.
The framing and EOF contract is documented in
[`independent/spec/ENGINE_CONTROL_API_V2.md`](independent/spec/ENGINE_CONTROL_API_V2.md).

Run the true two-process app-restart routing contract from `desktop/`:

```bash
npm run test:routing-restart
```

The parent creates one temporary userData directory. One Electron process
writes exact-domain and subdomain rules and exits; a second process reopens the
same directory and checks persisted rule resolution, the generated PAC, and
single-Session browser ownership. The parent enforces hard deadlines and
removes the temporary directory. This is offline persistence evidence, not a
campus-site availability test.

### 1.2.1 performance work

The 1.2.1 performance gate has two deliberately different layers:

1. **Offline disaster guards** fail builds on hangs, leaked views/timers, hidden
   application enumeration, or very large latency regressions. They use only
   synthetic loopback/blocked-port inputs and do not contact the gateway.
2. **Product targets** describe the desired experience, such as 20-tab switch
   p95 and hidden main-process CPU. They are reported but are not release gates
   until repeated measurements exist for supported school devices.

Run the deterministic hidden-idle baseline from `desktop/`:

```bash
npm run test:idle-performance
```

Run the existing real-Electron, synthetic-network 20-tab/lifecycle gate:

```bash
npm run test:browser-performance
```

Each command emits one bounded line prefixed with
`HKUSTGZ_DESKTOP_PERF_JSON ` using schema
`hkustgzconnect.desktop-performance.v1`. Store the line together with commit,
OS, architecture, Electron version, power mode and whether the machine was on
battery. These reports do not measure gateway latency, tunnel throughput, DNS
latency or real campus-page rendering.

## Future 1.3 Gateway MFA milestone

1.3保留给学校Gateway首次真实启用MFA后的独立认证版本。当前generic challenge framework、
Control v3、synthetic provider和Campus Browser网页MFA安全只证明架构可扩展，不构成1.3
功能，也不会因为类型或UI已经存在而提前发布该版本。

### Entry gate

只有同时满足以下条件才启动1.3 production实现：

1. 学校提供受控MFA profile、授权测试身份和可比较的官方客户端；
2. 至少一种真实方法有脱敏的状态、字段、失败和cleanup证据；
3. synthetic HTTPS Gateway可以覆盖Cookie/CSRF rotation、partial body、timeout/reset和logout；
4. Password→Challenge共用一个AuthAttemptBudget，continuation不能绕过Engine预算；
5. provider可以独立feature-disable，不修改Modern L3、DNS、SOCKS或Campus Browser核心。

### Exit gate

1. 只对已验证的具体方法达到至少`I3/E4`，其余方法继续fail-closed；
2. success、reject、indeterminate、expiry、resend、cancel和cleanup-unconfirmed均有稳定结果；
3. OTP、Cookie、TwfID、CSRF、continuation和transport token不进入Renderer持久状态、日志、
   telemetry、clipboard或crash report；
4. password-only路径完整回归，MFA关闭后不改变现有Transport/frontend；
5. 同profile官方客户端parity、staff canary、rollback和跨平台package gate通过。

详细状态机和activation contract见
[`docs/architecture/mfa-architecture.md`](docs/architecture/mfa-architecture.md)。在真实证据
出现前，1.3保持`Deferred / evidence-triggered`，项目不猜测endpoint、验证码形状或渠道映射。

## Campus Connect 2.x product roadmap

The 1.x line is historical maintenance context. Stable 2.0.0 is published and `main` is the current
maintenance authority. The capability rows below remain evidence-gated: a Partial or Deferred row
is not advertised as a working school feature.

The completed preparation ledger remains under
[`docs/plans/2.0-preparation-execution-plan.md`](docs/plans/2.0-preparation-execution-plan.md)
as historical evidence. Current repository-governance and modularization work is controlled by
[`GOAL.md`](GOAL.md) and
[`docs/architecture/modularization-plan.md`](docs/architecture/modularization-plan.md).

2.0产品目标是 **Campus Workspace + Secure Access Runtime**：普通用户从资源搜索、收藏、最近
访问和通知进入，连接按资源需要自动触发；高级用户展开SSH、代理、转发、Underlay和Headless。
数据层从一开始区分`SchoolProfile → CampusAccount → WorkspaceScope`。

普通学校选择器只展示reviewed profiles。`Other`自定义HTTPS Gateway放在高级设置，并在第二个
reviewed school完成后才开放；它仍需无凭据探测、身份确认和独立profile/account workspace，
不得通过猜协议并自动提交密码实现“通用兼容”。

产品、账户和资源定义见
[`docs/product/2.0-product-definition.md`](docs/product/2.0-product-definition.md)、
[`docs/adr/0004-profile-account-workspace-scope.md`](docs/adr/0004-profile-account-workspace-scope.md)和
[`docs/architecture/resource-domain-model.md`](docs/architecture/resource-domain-model.md)。

Profile/account isolation, RoutingPolicyIR and the local Resource Workspace may progress from current-source and
synthetic evidence without claiming a new Gateway capability. The trigger for each proprietary authentication,
resource-catalogue or transport capability remains evidence that a controlled school profile enables it. That
work covers one capability, compares with the supported official client and passes the promotion checklist before
its evidence level changes or it is marked Supported.

The table below tracks evidence-gated Gateway capabilities; it does not replace the P1–P8 product/foundation
order in the Revision 4 execution plan.

| Order | Capability | Implementation / evidence | What exists now | Required next evidence/work |
| ---: | --- | --- | --- | --- |
| 0 | `AuthProvider`, `ResourceProvider`, `TransportBackend` boundaries | `I3/E2` | Stable Rust traits, typed `Supported`/`Unsupported`/`Unavailable`, production password and L3 adapters, fail-closed contract tests | Keep vendor wire formats in narrow adapters |
| 1 | Server campus resource catalogue, groups and authorization | `I2/E2` | Bounded offline parser, opaque handles and redacted presentation v1; authorization values are only `declared_unverified` | Implement authenticated retrieval, expiry/refresh, authorization semantics and safe desktop presentation; canary all of them on the school profile |
| 2 | Announcements, passive kick, password expiry and forced-upgrade reason | `I1/E1` | Generic bounded engine lifecycle/error events exist | Add gateway-specific reason parsing plus `session_notice`, `password_change_required` and `upgrade_required`; test server-initiated cases live |
| 3 | WebVPN-only access when L3 is absent | `I1/E1` | The configuration parser recognizes a WebVPN endpoint and a typed backend slot exists | Implement authenticated WebVPN transport/resource rewriting; validate a profile with L3 disabled. Current production correctly fails instead of going direct |
| 4 | Multiple-line discovery and healthy selection | `I2/E2` | Multiple VPN endpoints can be parsed offline | Define authenticated discovery, bounded parallel health policy, sticky selection and safe failover; validate against multiple school-controlled lines |
| 5 | CAPTCHA | `I1/E1` | Auth state classification and provider challenge boundary exist | Implement challenge fetch/expiry/response/cancel and bilingual accessible UI against an enabled test account |
| 6 | SMS, TOTP and dynamic-token authentication | `I2/E2` | SMS/token states are classified; mock providers prove only that the interface is extensible | Implement each provider independently, including resend/rate-limit/expiry; validate each enabled method. The modern L3 transport token is not a user OTP feature |
| 7 | Isolated SSO, QR code and WeChat-style flow | `I1/E1` | States are recognized; the ordinary Campus Browser is isolated | Build a separate authentication session, callback/state binding and cancellation contract; validate each enabled identity-provider flow. Browser isolation alone is not SSO support |
| 8 | Certificate, USB Key and HID authentication | `I1/E1` | Capability recognition and explicit unsupported errors only | Begin only after the school supplies an approved profile, device/key lifecycle and vendor-supported comparison environment; use platform credential APIs, not process-scanning shims |

## Deliberate non-goals

The following official-client behaviors are not parity targets:

- changing global DNS, the default route or the operating-system proxy by
  default;
- a root/administrator-resident service merely to keep the GUI connected;
- process-driven USB monitoring, security-desktop impersonation or compliance
  bypasses;
- globally ignoring certificate errors or disabling browser web security;
- proprietary RemoteApp drivers without a separate school-approved product and
  security assessment.

System integration, if the school later needs it, must be a signed, reversible,
opt-in platform component with scoped routes/DNS and an auditable rollback. It
must not weaken the isolated browser and explicit-proxy defaults.

## 2.0.0 promotion checklist for every activated capability

1. Obtain authorized official-client behavior from a school-controlled enabled
   profile; never use production student credentials as a fixture.
2. Record a sanitized, bounded contract fixture and the expected failure mode.
3. Implement one provider/adapter without changing unrelated frontends.
4. Keep unsupported, unknown and expired states as typed fail-closed tests.
5. Compare official and independent clients on the same test profile.
6. Canary on staff devices, document rollback, then and only then raise the
   implementation/evidence levels and mark the capability Supported.
