# 未发布修复索引

- Status: Current source contract
- Owner: project maintainers
- Last verified: 2026-10-13
- Applies to: main after 2.0.4; not included in published 2.0.4 installers

本轮断网自动恢复等修复已整理到 [2.0.4 发布说明](RELEASE_NOTES_2.0.4.md)。
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
