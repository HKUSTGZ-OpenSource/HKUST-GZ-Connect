# 未发布修复索引

- Status: Current source contract
- Owner: project maintainers
- Last verified: 2026-10-13
- Applies to: main after 2.0.4; not included in published 2.0.4 installers

本轮断网自动恢复等修复已整理到 [2.0.4 发布说明](RELEASE_NOTES_2.0.4.md)。

## 学校切换 / School switching

- 修复旧版本切换失败后因来源凭据版本过期而无法启动的问题；仅在身份和事务校验通过后恢复原切换，不清空账号或网站数据。
- Recover interrupted switches with an older source credential revision only after identity and transaction checks; account and website data are not reset.

- 修复保存、更新或移除登录凭据后无法切回其他学校的问题；切换读取最新的账户凭据版本，继续严格核对学校、账户和工作区身份，不删除其他学校的数据。
- Fix switching schools after saving, replacing or removing login credentials. Live switching uses the current credential revision while retaining strict profile, account and workspace ownership checks; other schools' data is preserved.
正式安装包与验收结果以 [GitHub Release](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/releases/tag/v2.0.4) 为准。

## 门户读取 / Portal reads

- 修复门户分类、课表和新闻请求收到响应头后超时提前结束的问题。截止时间覆盖正文读取；
  卡住的正文会取消并结束本次读取，不再无限等待。查询参数、数据校验、会话和网络路径不变。
- Keep the existing portal request deadline active through body consumption, so stalled catalog,
  calendar and news responses terminate instead of waiting indefinitely. This does not establish
  real-school availability or close the separate calendar reporter acceptance.

## 浏览器关闭 / Browser disposal

- 显式关闭失败或被网页阻止时保留 Browser 及原生窗口的管理引用，阻止新命令，并允许重试清理。
  独立清理步骤会全部尝试，失败原因不会被后续步骤覆盖；普通关窗和账户切换合同保持不变。
  保留的旧页面不会获取新代理凭据或发起新的证书信任操作。
- Failed or vetoed explicit disposal retains Browser/native ownership, retires admission and permits
  cleanup retry. Independent cleanup steps are attempted without dropping their failure causes;
  retained pages cannot borrow proxy credentials or initiate certificate trust. Ordinary window
  closing and account-switch contracts remain unchanged.

## 浏览器会话 / Browser Sessions

- 修复重新创建浏览器后，持久化会话仍调用旧请求检查或被旧代理配置覆盖的问题。
  新浏览器接管会话后，旧配置和旧请求不会干扰新路径；Cookie 与网站登录状态保持不变。
- Persistent Session replacement binds the current request check and serializes native proxy
  writes across runtimes. Retired work cannot overwrite the current path or stall it during
  read-only policy preparation; cookies and website login state are preserved.

## 工具栏命令 / Toolbar commands

- 修复旧浏览器窗口关闭后，迟到的网站打开结果仍刷新新窗口或显示过期错误的问题。
  查找状态随窗口清理；当前窗口的正常操作和错误反馈保持不变。
- Late toolbar/resource results no longer refresh replacement windows or publish retired-window
  errors. Find state is cleared with window cleanup; current commands and feedback are preserved.
