# Windows + WSL 开发交接

- Status: Current development handoff
- Owner: project maintainers
- Last verified: 2026-11-04
- Applies to: Windows/WSL 主开发与 macOS 专项维护；源码基线 `e6dfca371ad5e910858832dea8dcd783a1fa020f`
- Tracking: [#288](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/288)

新电脑从远端 `main` 接手。主要开发在 Windows + WSL；Mac 保留 macOS 小改动、原生回归、
签名与封包。各平台通过已提交的 Git 源码同步，各自安装依赖和生成产物。
这是开发交接，不迁移已安装 App 的账号、密码、Cookie、浏览器会话或私人学校材料。

## 1. 先读什么、当前到哪里

依次读根目录 [AGENTS](../../AGENTS.md)、[架构](../../ARCHITECTURE.md)、
[GOAL](../../GOAL.md)、[贡献指南](../../CONTRIBUTING.md)，以及修改目录最近的 `AGENTS.md`。
[文档地图](../README.md) 定义事实来源；历史计划和本地候选不能覆盖当前主线。

2026-11-04 已通过 `git fetch` 和 GitHub readback 核对：

| 对象 | 精确身份与边界 |
| --- | --- |
| 交接前 main | `e6dfca371ad5e910858832dea8dcd783a1fa020f`；原 Mac 主工作区干净 |
| 最新稳定版 | [v2.0.5](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/releases/tag/v2.0.5)，2026-10-30 发布 |
| 注释 tag | `5260793c009d24bd212bdb4aaf2bf3a6924a855f`，解引用到上述 main |
| 发行元数据 | 四个安装包及 `BUILD_RECEIPT.json`、`SHA256SUMS.txt` 存在；本次未重新下载验签或做校园登录 |
| 已入主线进度 | #266 门户正文 deadline；#268/#270/#272 Browser 退休与会话归属；#275/#281 学校切换凭据与启动恢复；#279/#280 依赖；#285 2.0.5 准备 |
| 原本地独有工作 | #273 证书异步确认修复已通过 [PR #289](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/pull/289) 合入 `771f2ac14a2fa05b350efc0219c3d2b779a93689`；不属于 v2.0.5 安装包 |

上述 SHA 是交接基线；接手时以 `git rev-parse HEAD origin/main` 记录实际最终 SHA，
并查看 [#288](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/288)
关联 PR 的合并记录和精确检查。不要把本文件的日期当成新机验收结果。

## 2. 三个环境的分工

| 环境 | 工作 | 必须分开的证据 |
| --- | --- | --- |
| WSL 2，建议 `~/src/HKUST-GZ-Connect` | 共享逻辑、Rust/Node 开发、单测、源代码门禁 | Linux 结果；WSLg 不是原生 Windows GUI |
| 原生 Windows，建议 `C:\src\HKUST-GZ-Connect` | Windows helper、DACL/DPAPI、进程管道、Windows UI、NSIS | Windows x64 原生结果 |
| Mac 原工作区/专项分支 | macOS 小改动、Electron 原生验收、arm64/x64 DMG 与签名 | macOS 架构和签名结果 |

两个新机 checkout 独立 clone。不要在同一 checkout 混用 Windows 与 Linux 的 Git/Node/Rust，
也不要共享 `desktop/node_modules/`、`independent/target/`、`desktop/engine/` 或 `desktop/release/`。
WSL 源码放在 Linux 文件系统；Windows 源码放在 Windows 文件系统。
参见微软 [WSL 环境建议](https://learn.microsoft.com/en-us/windows/wsl/setup/environment)。

使用 Node.js **24** 和 npm 锁文件；Rust 以 `independent/rust-toolchain.toml` 为准，
本检查点为 **1.97.1**，含 rustfmt/clippy。`Cargo.toml` 的 MSRV 不替代开发工具链。
Electron 锁定 **43.8.1**；electron-builder **27.0.0-alpha.9** 是已审核的预发布版本，
不能把它称为稳定工具，也不要在新电脑执行未审查的 `npm update`。

## 3. WSL 首次接手

先准备 WSL 2 的 Linux 发行版、Git、Linux Node 24/npm、rustup 和本机 C/C++ 构建工具。
这些是新机前提，本次没有远程安装或验证它们。GUI/Electron 还需要该发行版的图形依赖；
先完成无 GUI 检查，再单独验证 WSLg/显示环境。

以下 Bash 命令遇错即停；以无秘密的测试输出保存版本、SHA 和结果：

```bash
set -euo pipefail
mkdir -p ~/src
cd ~/src
git -c core.autocrlf=false clone https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect.git
cd HKUST-GZ-Connect
git config core.autocrlf false
git fetch origin --prune
git status --short --branch
git rev-parse HEAD origin/main
node --version
npm --version
node -p "process.platform + ' ' + process.arch"

cd independent
rustup show active-toolchain
rustc -vV
cargo fmt --all -- --check
cargo clippy --locked --all-targets --no-default-features -- -D warnings
cargo test --locked --no-default-features

cd ../desktop
npm ci
npm test
npm run check:architecture
npm run check:governance
npm run check:install-scripts
npm run check:syntax -- --tree HEAD
npm run check:secrets -- --tree HEAD
npm run audit:ci
```

Node 应报告 `linux`，Rust host 应为 Linux；若误用了 Windows PATH 中的工具，先修正工具选择。
`--tree HEAD` 只证明已提交源码；提交前修改应暂存后检查 index，提交后再核对精确 HEAD。
审计网络失败是环境/证据缺口，不是代码失败，也不能记录为通过。

需要生产 Engine/本地 Desktop 时，在仓库根运行 `bash desktop/scripts/build-engine.sh`，
然后 `cd desktop && npm start`。脚本构建三个生产程序并暂存已审核 Profile；不要只复制旧的
`hkustgz.json`。`npm start` 是交互入口，真实账号登录和校园测试仍需另行明确范围。
合成认证回归则从 `independent/` 运行：

```bash
cargo build --locked --no-default-features --bin ec-auth-fixture
node ../desktop/e2e/auth-control-fixture.js
```

完整 Rust test-feature 和 Electron 验证矩阵以 [RELEASING](../../RELEASING.md)、
最近的 `AGENTS.md` 与 [CI](../../.github/workflows/ci.yml) 为准；上述首轮检查不替代所有验收。

## 4. 原生 Windows 验收与打包

安装 Windows x64 Git、Node 24/npm、rustup 的 MSVC 工具链，以及 Visual Studio/Build Tools
的 **Desktop development with C++**（x64 工具与 Windows SDK）。
参见微软 [Rust 开发环境](https://learn.microsoft.com/en-us/windows/dev-environment/rust/setup)。
helper 构建脚本可通过 `vswhere` 寻找 Visual C++；不要把编译器环境完整输出到日志。

在 PowerShell 中新建独立 clone，设置该仓库 `core.autocrlf=false`，核对同一 Git SHA。
Node 必须报告 `win32 x64`，Rust host 为 `x86_64-pc-windows-msvc`。
下列封装检查每条外部命令的退出码，不仅依赖 PowerShell 的异常偏好：

```powershell
$ErrorActionPreference = 'Stop'
function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed: $LASTEXITCODE" }
}
# 从已 clone 的仓库根运行
Invoke-Checked git @('status', '--short', '--branch')
Invoke-Checked git @('rev-parse', 'HEAD', 'origin/main')
Invoke-Checked node @('-p', "process.platform + ' ' + process.arch")
Set-Location independent
Invoke-Checked rustup @('show', 'active-toolchain')
Invoke-Checked rustc @('-vV')
Invoke-Checked cargo @('fmt', '--all', '--', '--check')
Invoke-Checked cargo @('clippy', '--locked', '--all-targets', '--no-default-features', '--', '-D', 'warnings')
Invoke-Checked cargo @('test', '--locked', '--no-default-features')
Invoke-Checked cargo @('test', '--locked', '--no-default-features', '--test', 'proxy_command_pipe')
Invoke-Checked cargo @('build', '--locked', '--release', '--no-default-features', '--bin', 'ec-engine', '--bin', 'ec-proxy-command', '--bin', 'ec-gateway-probe')
New-Item -ItemType Directory -Force -Path ../desktop/engine | Out-Null
Copy-Item target/release/ec-engine.exe ../desktop/engine/ec-engine-windows-amd64.exe
Copy-Item target/release/ec-proxy-command.exe ../desktop/engine/ec-proxy-command-windows-amd64.exe
Copy-Item target/release/ec-gateway-probe.exe ../desktop/engine/ec-gateway-probe-windows-amd64.exe
Invoke-Checked node @('../desktop/scripts/stage-reviewed-profile-configs.js')
Set-Location ../desktop
Invoke-Checked npm.cmd @('ci')
Invoke-Checked npm.cmd @('run', 'test:windows')
Invoke-Checked node @('--test', 'test/unit/integrations/external-proxy-config.test.js')
Invoke-Checked npm.cmd @('run', 'check:architecture')
Invoke-Checked npm.cmd @('run', 'check:governance')
Invoke-Checked npm.cmd @('run', 'check:install-scripts')
Invoke-Checked npm.cmd @('run', 'check:syntax', '--', '--tree', 'HEAD')
Invoke-Checked npm.cmd @('run', 'check:secrets', '--', '--tree', 'HEAD')
Invoke-Checked npm.cmd @('run', 'audit:ci')
Invoke-Checked npm.cmd @('run', 'dist:win')
Invoke-Checked node @('build/verify-package.js', 'release/win-unpacked/resources', 'win32', 'x64')
```

`test:windows` 与 `dist:win` 会先构建原生 private-file helper；在 WSL 上运行它们会拒绝，
不能把平台 skip 当成 Windows 通过。以上脚本以当前正式 [build workflow](../../.github/workflows/build.yml)
的三个程序和 Profile staging 为依据。`ci.yml` 的 Windows package fixture 在此基线仍只复制
单一 `hkustgz.json`：这是需要独立评估的 CI 覆盖差异，本次未修改 workflow，也不宣称已覆盖多学校打包。

包校验之后仍需 Windows GUI、安装/启动、DACL/DPAPI、升级与对应功能验收；安装副本、源码、
离线 fixture 和真实 Gateway 结果分别记录。不得通过复制 Mac 用户数据来恢复登录。

## 5. Mac 后续怎么工作

从远端 main 拉取已合并源码。macOS 改动仍以一个 issue、一个隔离分支/工作区开展；
推送前运行相关 macOS 回归与精确源码门禁，最终合回同一 main，不保留分叉的 Mac 主线。
需要双架构安装包时使用 [build workflow](../../.github/workflows/build.yml) 的对应架构构建和暂存顺序。

只做当前 Apple Silicon 架构的本地封包，可在干净工作区运行：

```bash
set -euo pipefail
git rev-parse HEAD
bash desktop/scripts/build-engine.sh
cd desktop
npm ci
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac dmg --arm64 --publish never
node build/verify-package.js release/mac-arm64/hkustgzconnect.app/Contents/Resources darwin arm64
codesign --verify --deep --strict release/mac-arm64/hkustgzconnect.app
```

该例只适用于 arm64 Mac；不能以它宣称 x64 验证。`afterPack` 选择实际可用本机签名身份，
需记录最终类别，不能推断已公证。`desktop/scripts/rebuild-mac.sh` 会替换 `/Applications` 内的
已安装 App，因此不作为默认“只封包”命令。发布/tag/上传安装包仍需单独授权。

## 6. 未完事项和接手顺序

先完成新电脑双环境的版本/SHA/首轮检查，再按 issue 认领任务。以下是 2026-11-04 快照，
接手前再次查看 [开放 issues](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues)
和 [PR 队列](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/pulls)。

| 事项 | 接手动作与验收边界 |
| --- | --- |
| [#273](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/273)，已关闭 | 原本只在 Mac 的证书 owner 修复已通过 [PR #289](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/pull/289) 合入 main；使用 main，勿重复合入旧分支。未发布，不关闭父 #80 |
| [#282](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/282) | Gateway 地址策略拒绝被显示为配置损坏；按 typed error/双语指引和 synthetic 地址覆盖推进，不放宽地址策略 |
| [#127](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/127) | 原 Windows 登录/连接报告尚待脱敏复现或受影响用户复测；新机本地测试不自动关闭它 |
| [#177](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/177) | 门户真实课表遗漏仍需报告者确认；源代码修复和合成测试不能替代 |
| [#287](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/287) | 两台 Mac 同时连接的网关/客户端原因未确认；不得绕过网关会话限制或同步 token |
| [#79](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/79) / [#80](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/80) / [#83](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/83) | M1 Renderer、M2 Browser 全生命周期、M5 导入/visibility；完整验收见 [检查点](2026-10-13-convergence-checkpoint.md)，不要用单次提取关闭总项 |
| [#84](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/84) / [#60](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/60) | G4 与总体治理仍未完成；角色/权限改变须另有明确授权 |
| [PR #277](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/pull/277) / [PR #286](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/pull/286) | asar 4.x / Rust 兼容依赖更新；已在远端保存，仍需独立依赖评审及当时最新 base 的门禁，不混入交接文档 PR |

2026-11-04 protection readback：main 需要一个独立审批与七项 strict checks：
`secret-scan`、`package-verifier`、`desktop`、`desktop-electron`、`windows-private-file`、
`engine`、`offline-tests`。Agent review 不能伪装成人类审批；历史管理员例外不成为常设豁免。
继续本地先验、集中推送，避免把 Actions 当反复试错工具。

本次 #289 在所有必需检查通过后，依据维护者的明确一次性授权，豁免缺失的人类审批并
完成管理员 squash 合并。此授权同时限定覆盖 #288 的交接文档 PR，仍以其全部必需检查
通过为前提；不改保护规则、不构成未来豁免或发布授权。

## 7. 本地工作保全账本

迁移前盘点了 **153 个分支、102 个 worktree、0 个 stash**：3 个分支已在 main 祖先链，
1 个与当前 main 树相同，89 个累计补丁与 main 的 squash commit 精确匹配，2 个与历史 main
树相同，58 个仍需历史上下文。未匹配不代表 58 个待合并功能；没有批量合并或删除它们。
2.0.5 本地发行分支与 main 的 tree 都为 `8787843c476bc7865166693e46883ce584cb01f3`，
已通过 #285 合并。最新独立遗漏是 #273 的原提交 `8aee9c02a8608e5f1a4c75854cec142a7c5b2fdd`。

14 个旧工作区有未提交路径：9 个是 `desktop/node_modules` 依赖软链接；4 个存在 tracked
修改（类别有重叠），其余为历史记录或构建材料。以下全部留在 Mac 原位置，未提交/上传：

- `.worktrees/dependency-security-repair{,-clean}`：两套相同旧 package/lock 尝试，版本落后于 main。
- `.worktrees/private-stat-precision-review`：旧 category E2E 诊断插桩与私人 checkpoint 文件。
- `.worktrees/release-2.0.2-patched-mac`：旧 category E2E 等待补丁，当前 main 已有相应处理。
- `.worktrees/goal-combination-check` 的历史组合记录、`.worktrees/issue97-mac-package/package-evidence/`
  和 `.worktrees/release-2.0.2-secure-package/desktop/engine-arm64-staged/`：历史材料/生成物。

这些不构成新机的当前开发依赖。未知分支/历史原始材料仍可在 Mac 恢复，未声称已经清理或迁上云。
不要提交整个工作目录、依赖缓存、安装包、私人证据或登录数据来“补齐”迁移。

## 8. 验收与回滚记录

交接 PR 记录 base/head/tree、变更路径、逐项执行命令、独立审查和远端检查；#273 使用独立 PR。
文档最低门禁是相对链接/状态核对、`check:governance` 和 `git diff --check`，本次另跑架构、
语法与精确树 secret gate。具体运行结果以各 PR 的收据为准，不将本文命令清单当作已执行记录。

#289 在 Node 24.22.1 / Electron 43.8.1 的 Mac 上通过 2,194 项 Desktop 测试（16 平台 skip），
原实现的四项异步回归先失败，修复后的证书安全测试 14/14 通过；native toolbar、MFA、
popup-MFA、strict-proxy 通过。独立 agent 审查重复了 14/14 及旧/新实现对照。
CI `41802444896` / offline `41802444857` 的七项必需检查及三平台 package jobs 全部通过。
这些是源码、离线/native fixture 和包验证证据，未做新的真实 TLS/校园登录验收。

新机验收尚待执行：WSL 发行版/工具链、Linux 首轮检查、Windows 原生 helper/测试/安装包/UI，
以及任何另行授权的真实学校验证。若工具不可用，记录环境缺口并暂停依赖该证据的结论。
文档回滚可以 revert 交接 PR；#273 可单独 revert，但会恢复已知竞态。迁移不改持久化 schema，
不会删除 Mac 源码、依赖或已安装应用数据。
