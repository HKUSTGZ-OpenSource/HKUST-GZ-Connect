# 未发布修复索引

- Status: Current source contract
- Owner: project maintainers
- Last verified: 2026-11-05
- Applies to: 2.0.5 source history and fixes selected for the 2.0.6 candidate

学校切换、门户读取、浏览器关闭、会话与工具栏修复已纳入 [2.0.5 发布候选说明](RELEASE_NOTES_2.0.5.md)。后续未发布修复在对应章节单独标明；实际安装包和验证结果以 GitHub Release 为准，不改写既有产物。

网关地址策略和证书归属修复已选入 [2.0.6 发布候选说明](RELEASE_NOTES_2.0.6.md)；实际发布状态以 GitHub Release 为准。

## 2.0.6 候选：网关地址策略 / 2.0.6 candidate: Gateway address policy

- 港科广内置配置启用已审核的内网网关策略，支持同一学校域名的内外网解析；不硬编码本机地址，不改变未知网关规则、证书校验或系统网络。
- 网关地址策略拒绝改为独立错误提示，不再建议重装；继续停止自动重试，并引导检查学校、DNS 和代理解析。
- The reviewed HKUST(GZ) profile accepts private Gateway resolution through the existing policy exception. Unknown/custom gateways, forbidden or mixed scopes and TLS verification remain unchanged.
- Address-policy rejection has an explicit terminal diagnostic instead of a misleading reinstall message. This candidate is not included in 2.0.5; Windows/WSL primary-maintainer review and native acceptance remain separate.

## 已发布学校切换修复 / Released school-switch fixes

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

## 证书询问 / Certificate consent

状态：2.0.5 之后的未发布修复。 / Status: Unreleased after 2.0.5.

- 证书询问执行前重新检查原浏览器和页面归属；关闭或替换后排队的请求会被拒绝，
  避免把旧页面的询问转交给新窗口。
- Deferred certificate consent rechecks the admitted Browser and page ownership before dispatch.
  Retired or replaced requests are denied without borrowing another Browser's trust decision.

## XML 解析与证书信任 / XML parsing and certificate trust

- 更新 XML 解析器，避免深层嵌套元素在解析阶段耗尽栈并使 Engine 退出；保持现有输入大小、UTF-8 与 DTD/entity 边界。
- Update the XML parser to avoid parse-stack exhaustion on deeply nested elements while retaining existing input-size, UTF-8 and DTD/entity boundaries. This does not claim that every downstream XML consumer is stack-safe.
- 默认 TLS 信任库跟随上游移除 emSign Root CA - C1 与 emSign ECC Root CA - C3。仅能链到这两个根的网关将不再通过默认 PKI 验证；已有精确来源的显式叶证书信任机制不变。
- The default TLS trust store removes emSign Root CA - C1 and emSign ECC Root CA - C3 following upstream. Gateways relying solely on those roots fail default PKI verification; existing explicit origin-bound leaf trust is unchanged.
