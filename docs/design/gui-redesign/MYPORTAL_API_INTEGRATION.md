# myPortal API 接入准备

- 状态：已实现的只读适配器；学校接口合同仍待确认
- 负责人：Desktop Browser 维护者
- 最后核对：2026-09-27
- 适用范围：HKUST(GZ) Profile 的 myPortal 日程、资讯与目录读取

## 已确认的公开行为

访问 `https://myportal.hkust-gz.edu.cn/` 会进入学校 SSO。当前公开登录流程使用 OIDC Authorization Code + PKCE；可观察到的客户端标识为 `dingportal.prod`，回调回到 myPortal。这里仅把该行为用于判断“校园浏览器会话是否已登录”，不保存授权码，不读取密码，不把 Cookie 或 Token 发送给 Renderer。

## 当前实现边界

```text
校园工作台 Renderer
    │  get-campus-data / refresh-campus-data / refresh-campus-schedule（无参数）
    │  get-campus-schedule-week（仅限日期与布尔 force）
    ▼
Trusted IPC 白名单
    ▼
MyPortalDataRuntime（Main）
    │  Session.fetch(credentials=include, Accept=*/*)
    ▼
与校园浏览器相同的 persist: 分区
    │
    ├── 会话探测：只判断 authenticated / unauthenticated / unknown
    ├── 已绑定只读适配器：weekly schedule / news
    ├── 动态目录：34 个账号应用 / 23 个学生服务（以门户实时响应为准）
    └── 待正式接口：loans
```

关键文件：

- `desktop/lib/browser/session/browser-session-manager.js`：会话复用、缓存、超时、模块隔离与受限展示模型。
- `desktop/lib/ipc/browser-data-ipc.js`：三个无参数数据 IPC 通道，以及独立的浏览数据清理通道。
- `desktop/renderer/campus-data-modules.js`：独立状态机和真实数据渲染。

## 当前接入策略

公开入口只证明登录流程存在，不证明课程、借阅或资讯接口的长期稳定性与第三方使用合同。实现不抓取 DOM，而是在用户明确授权的已登录会话中确认只读请求后，将日程与资讯绑定到隔离适配器；图书借阅仍返回 `source-unavailable`，避免猜测接口。会话探测允许同一 Electron Session 完成学校 SSO 的静默续期；最终 URL 中的短期路由参数只用于确认该 Main 进程见过登录后的门户页，不复制到 API 请求，不写日志、不进入 Renderer。

周课表的默认缓存与自动刷新周期为 24 小时。窗口重新聚焦不会在有效期内重复请求；课表标题区的“刷新”按钮优先使用限定日期的 `get-campus-schedule-week` 通道，旧兼容路径使用无参数的 `refresh-campus-schedule`，两者都不连带刷新应用目录、学生服务台、资讯或借阅模块。缓存仅存在于当前进程内，不把个人课表额外落盘。

门户对个人分类的 `calendarList.rst` 读取按校园时区的单日区间发起，另有一条 `categoryIds=-1000` 的跨周请求，不能未经响应合同确认就把两者当作同一数据源。应用的周视图现在聚合固定七天的个人分类只读请求：并行请求以控制等待时间，任一天失败则整周失败关闭，不把不完整结果称为“暂无安排”；相同日程去重后最多下发 64 项，仍沿用上述 24 小时周缓存。请求和测试不记录个人日程原文或会话参数。

应用目录和学生服务条目不在列表中重复显示自动、直连或校园隧道标识；所有访问仍使用同一份已审查规则解析器，例外规则只在控制塔的“网站网络规则”中维护。条目收藏复用本机 `create-favorite-resource`、分类与移动事务，Renderer 只提交名称、无凭据 HTTPS URL、自动路由偏好和分类标识。

## 真实会话发现（2026-09-04）

在用户已登录的 Chrome myPortal 页面中，以只读 DevTools Network 观察并删除所有临时参数值后，确认了以下请求：

| 模块 | 已确认路径 | 参数键（仅名称） | 结果 |
|---|---|---|---|
| 日程分类 | `/calendar/mgr/api/category/list.rst` | `_p callback categoryIds queryType` | 已登录会话使用 |
| 个人日程（逐日聚合周视图） | `/calendar/mgr/api/hkust/calendarList.rst` | `_p callback categoryIds fromDate endDate queryType type t` | 已绑定；事件为 `events[].schedule.title/location` 与 `beginTime/endTime`；学校页面的跨周 `-1000` 请求尚未当作个人日程源 |
| 我的应用 | `/sopplus/_web/customized/getMyFavoriteAppsByCategory.jsp` | `_p callback clientType name parentCategoryId` | 已绑定；5 分类、当前账号 34 项，顺序以门户为准 |
| 服务分类 | `/sopplus/_web/customized/getPortalCenterTermByStrategy.jsp` | `_p parentCategoryId showCategoryType` | 已绑定；3 分类 |
| 学生服务台 | `/sopplus/_web/customized/loadAllServiceApps.jsp` | `_p categoryId clientType parentCategoryId` | 已绑定；当前 23 项，顺序以门户为准 |
| 门户资讯 | `/sopplus/_web/customized/getHkustArticleList.jsp` | `_p callback page pageSize wybs` | 已绑定；`200`，JSONP；`wybs` 区分公告等栏目 |
| 个性化资讯 | `/mnews/_web/customized/getPortalArticleList16ByUser.jsp` | `_p callback columnId page pageSize siteId` | 页面启动资源中确认 |
| 图书借阅 | 未确认 | — | 保持官方页面入口，不猜测 |

这些路径是“已验证候选”，不是学校对第三方客户端发布的正式 API 合同。当前适配器只读、短超时、限量投影并严格失败关闭；仍需学校后续确认响应字段、频率限制、使用许可，以及会话过期时的稳定行为。

## 正式适配器要求

每个适配器只实现一个模块，返回 `browser-session-manager.js` 中校验的受限投影：

```js
{
  state: 'ready',
  source: 'official-api',
  fetchedAt: 1800000000000,
  stale: false,
  items: [{
    id: 'event-opaque-id',
    title: 'Research meeting',
    startsAt: 1800000000000,
    endsAt: 1800003600000,
    location: 'E1',
    kind: 'meeting',
    url: 'https://myportal.hkust-gz.edu.cn/schedule'
  }]
}
```

适配器通过 Main 进程注入，当前只有 HKUST(GZ) 官方配置会得到日程与资讯 source：

```js
getSources: () => ({
  schedule: hkustScheduleSource,
  news: hkustNewsSource,
})
```

每个 source 暴露 `read({ session, portalUrl, sessionUrl, checkedAt, moduleId })`。请求必须使用传入的 Electron `Session`，以复用校园浏览器的登录与 PAC 路由；`sessionUrl` 仅作为 Main 内的会话证据，不得复制其短期参数、下发或记录。不得使用 Node 原生 `fetch` 绕过分区、代理或证书策略。

## 数据映射

| 模块 | 最小字段 | 最大条数 | 禁止下发 |
|---|---|---:|---|
| schedule | `id title startsAt endsAt location? kind url?` | 64 | Cookie、Token、原始个人资料、完整 API 响应 |
| loans | `id title borrowedAt? dueAt renewable url?` | 64 | 读者证号、罚款支付信息、账户标识 |
| news | `id title publishedAt unread url?` | 64 | 跟踪参数、个性化画像、原始 HTML |
| catalog | `groups[] applications[] serviceItems[]` | 各 64 | Cookie、Token、图标二进制、点击统计、原始响应 |

所有 URL 必须为无凭据 HTTPS；所有文本有长度上限；`ready` 必须至少有一项，只有上游明确返回空集合时才能写 `empty`。

## 接口确认清单

已绑定或后续新增 source 时，均需由学校接口文档或一次经授权的开发者会话确认：

1. endpoint、HTTP 方法、Content-Type 与重定向策略；Electron `Response.url` 不作为重定向证据。
2. 所需 scope、Cookie 或 CSRF 机制；是否允许桌面客户端复用。
3. 401、403、会话过期、维护、空集合的可区分响应。
4. 是否需要校园隧道；若需要，先走现有路由解析与连接门禁。
5. 响应字段的最小化映射与日志脱敏。
6. 测试账号/夹具的保存和销毁边界。

## 后续接入步骤

1. 用真实账号验证日程与资讯的非空、空集合、会话过期和维护状态。
2. 获取学校对这些只读接口的正式使用许可与 schema 说明。
3. 确认图书借阅的正式接口；在此之前不增加数据模拟或续借按钮。
4. 为经过确认的非空响应补充脱敏夹具，只保留映射所需字段。
