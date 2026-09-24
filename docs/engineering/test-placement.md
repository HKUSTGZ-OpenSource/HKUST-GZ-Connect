# Desktop 测试归属与遗留清单

- Status: M5 test-placement contract; source-only, not released
- Owner: Desktop and repository maintainers
- Last verified: 2026-09-25
- Applies to: `desktop/test/`, root-test debt manifest schema 1

## 放在哪里

| 测试对象 | 目录 |
| --- | --- |
| `lib/<domain>/` 的单一模块 | `desktop/test/unit/<domain>/`，尽量镜像生产目录 |
| Renderer 功能/组件 | `desktop/test/unit/renderer/`，例如 `card-board/` |
| 跨模块和仓库约束 | `desktop/test/contracts/` |
| 多模块交互 | `desktop/test/integrations/` |
| 真实 Electron 窗口、页面与生命周期 | `desktop/e2e/` |

从 `desktop/` 运行 `npm test` 仍自动发现嵌套 Node 测试。Windows smoke 的显式路径在
`test:windows` 与现有 CI 步骤中同步更新；不修改作业名称、触发器、权限、Action pin 或
检查强度。新增脚本或夹具遵循最近的 `AGENTS.md`；真实页面/包验证不能由文件字符串检查替代。

## 已完成的分组迁移

Card Board 的 controller、CSS contract、drag、icons、model、motion、view 共 7 个
根测试文件迁入 `test/unit/renderer/card-board/`。只改变相对引用，保留全部 43 项测试。
对应的生产组件、样式、用户数据和 UI 行为没有修改。

剩余根 JavaScript 文件从 59 个降为 52 个，精确列在
`.github/scripts/desktop-root-test-debt.json`。治理检查不再只比较数量：

- 新的根 JS/CJS/MJS 文件即使不增加总数，也不能替换旧文件占用名额。
- 已迁走或删除的文件必须同步删除清单例外，避免旧路径被悄悄重新使用。
- 重复条目、错误版本、额外字段、无效路径或超过当前上限的清单均失败。
- 普通功能开发不得扩大遗留清单；涉及检查合同的变更需要明确的治理审查。

后续独立 Renderer 功能测试又迁移 12 个文件到 `test/unit/renderer/`：认证挑战界面、浏览
数据设置、新标签设置、分类、搜索、工作台模型、连接概览、集成导出界面、通知、收藏、
代理认证迁移界面和学校选择器。该组移动前后均为 42 项测试，断言与夹具保持不变。
根目录遗留上限进一步从 52 降到 **40**；清单只删除对应旧路径，不新增替代名额。

最后 40 个文件按测试职责迁入以下目录，移动前后均为 187 项通过、2 项平台限定跳过：

- `contracts/main/`：主进程的账户上下文、设置读取、凭据、连接和退出等跨模块合同。
- `contracts/renderer/`、`contracts/browser/`：页面布局、Preload 接线、安全策略等源码合同。
- `contracts/connection/`、`contracts/profiles/`、`contracts/product/`、`contracts/packaging/`：
  对应跨模块及产品/包体合同。使用 `packaging/`，避免与禁止入库的生成目录 `release/` 混淆。
- `unit/tooling/`、`unit/build/`：架构/语法/审计/安装脚本等检查器、签名和包验证函数。
- `unit/browser/`、`unit/ipc/`、`unit/connection/engine/`、`unit/renderer/`：对应模块的单元测试。
- `integrations/cli/`、`integrations/platform/`、`integrations/profiles/`、`integrations/routing/`：
  CLI、Windows 启动、Profile 预就绪选择和路由一致性等组合测试。

当前测试根目录遗留上限为 **0**，清单 `rootFiles` 必须为空；任何重新引入的根
JS/CJS/MJS 文件或非空旧例外均失败。旧文档中的根测试路径只作为当时的历史证据保留。

测试根目录收束已完成；模块图逐路径/入口覆盖由 #140 执行，跨模块依赖边和 Rust
可见性检查仍未完成，不能因此宣称 M5 或整个仓库模块化已验收。

## 验证与回退

移动前后分别运行 `node --test test/card-board-*.test.js` 和
`node --test test/unit/renderer/card-board/*.test.js`，并比较测试名称和数量；之后运行
全量 `npm test`、架构、语法、安全、安装脚本和治理检查。Node 测试位移不要求下载新的
Electron 或删除构建缓存。

回退时一起恢复测试路径、相对引用与遗留清单/上限。没有持久化迁移，也不需要替换 App。
