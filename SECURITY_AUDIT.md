# Chrome 定时打开 / 自动刷新 / 日志插件 —— 安全审核与修复报告

- 审核时间：2026-10-14
- 输入项目：用户提供的 `Chrome_AutoOpen_AutoRefresh_Logs_V3.zip`
- 输出项目：`Chrome_AutoOpen_AutoRefresh_Logs_V3_1_SecurityFixed.zip`
- 结论：**发现并处理可无损修复的问题；未确认 Critical/High 代码漏洞或第三方依赖 CVE。存在与用户功能取舍相关的剩余风险。**
- 严重程度是对该项目威胁模型的保守评估，并不表示存在已知可公开利用的 CVE。

## 1. 项目结构和审核范围

| 项目 | 审查结果 |
|---|---|
| 项目类型 | Chrome 浏览器扩展，Manifest V3，原生 JavaScript / HTML / CSS，独立 Service Worker |
| 运行组件 | `background.js`、`popup.js`、`popup.html`、`popup.css`、`manifest.json` |
| 其他文件 | 4 个 PNG 图标，1 个使用说明 `.txt` |
| 版本 | 原 3.0.0 → 修复 3.0.1；`minimum_chrome_version` 为 120 |
| 包管理器 / 构建工具 | 无 `package.json`、lock 文件、`requirements.txt`、`go.mod`、`Cargo.toml` 等 |
| 直接 / 关键间接依赖 | **0 / 0**（无已打包的第三方 JavaScript 库） |
| CI/CD | 未提供工作流、发布流水线或自动化测试配置 |
| 代码审查覆盖 | ZIP 成员清单、入口和配置、全部 JS、HTML、CSS、图标与使用说明、存储/消息/权限/访问目标逻辑 |
| 仓库历史 | 未包含 `.git`，无法检查过去提交的密钥和真实版本控制状态 |

**依赖漏洞审核：** 该项目没有直接或锁定的第三方包，因此不存在可逐包查询的已安装依赖版本；`npm audit`、`pip-audit` 等缺少对应依赖清单，故不运行，并不把“不适用”当作“已无漏洞”。查阅 Chrome 官方扩展权限、消息机制、存储和 Service Worker 文档，未凭空报告 CVE。项目内也未发现疑似仿冒或停止维护的第三方包。

**压缩包安全：** 解压前检查成员路径、符号链接和单文件大小，无路径穿越、超大成员或符号链接。源项目没有文件上传、解压执行、模板渲染、数据库、HTTP 服务或 CI/CD 配置。

## 2. 问题汇总

文件位置均以**原版 V3.0.0**为准；修复后位置在下一节说明。

| 编号 | 类别 | 严重级别 | 位置（原版） | 风险和利用前提 | 状态 |
|---|---|---|---|---|---|
| SEC-01 | 代码 / 隐私 | **Medium** | `background.js:47-52,161-163,217,232,318,377-380,514` | 用户输入包含令牌的 URL 或标签标题含敏感信息时，被写入长久保存的日志；能读取扩展本地资料的人可能获得这些数据。 | **已修复（新日志）** |
| SEC-02 | 代码 / 消息鉴权 | Low | `background.js:458-465` | 后台未显式校验消息发起页面。当前没有内容脚本/外部消息监听，外部网页不能仅凭此调用 `onMessage`；若将来加内容脚本或其他入口，攻击面可能扩大。 | **已修复** |
| SEC-03 | 代码 / 存储隔离 | Low | `background.js:47-53,84-115,445-455` | `storage.local` 默认可被未来新增的内容脚本读取；现版没有内容脚本，属于防御加固。 | **已修复** |
| SEC-04 | 代码 / 策略防御 | Low | `manifest.json:1-21` | 原版沿用 MV3 默认安全 CSP，并非已经允许远程代码；策略没有显式声明，后续维护容易误改。 | **已加固** |
| SEC-05 | 密钥 / 隐私 | **Medium** | `background.js:19-25,55-65,84-93,138-143` | 用户未来粘贴带 token/password 的完整 URL 时，为实现重复打开会把完整 URL 保存到 `storage.local`，它不是加密凭据库。 | **待开发者决定** |
| SEC-06 | 隐私 / 遗留数据 | **Medium** | `background.js:47-53,445-455` | 之前运行 V3.0 产生的历史日志可能仍含完整 URL 或私人标题。自动删除会破坏用户现有日志。 | **待开发者决定** |
| SEC-07 | 权限 | Low | `manifest.json:8` | `tabs` 权限可读取窗口内其他标签 URL/标题。当前刷新功能需要识别网页、剔除 `chrome://` 与临时标签，无法直接无损移除。 | **建议关注** |
| SEC-08 | 代码 / 可用性与隐私 | Low | `background.js:138-195,405-443` | 扩展升级/重新加载会清空 `storage.session`；原有临时页可能丢失自动关闭追踪，停留在浏览器里。要跨升级恢复追踪需要持久化 tab/window ID，并处理误关标签风险。 | **待开发者决定** |
| SEC-09 | 配置卫生 | Low | 原 ZIP 根目录 | 没有 `.gitignore`，后续开发人员可能误提交 `.env`、签名私钥或 CRX 文件。当前没发现这些敏感文件。 | **已修复** |

**威胁前提说明：** Chrome 的内部 `runtime.onMessage` 与 `onMessageExternal` 是不同入口；原版也未配置 `externally_connectable`。因此 SEC-02 不应描述为“任意互联网网页可远程执行”，仅按防御纵深问题分级。

## 3. 直接完成的安全修复

1. **日志最小化 + 错误消息脱敏**：新增 `background.js:48-68` 的 `siteLabel()`、`safeLogMessage()`、`safeErrorText()`；打开、关闭、刷新和手动关闭仅记录 URL 来源（如 `https://example.com`），不再存完整路径、查询串、片段或网页标题。错误消息、控制台的日志输出也进行脱敏处理。刷新目标展示仅使用来源信息（`background.js:335`）。这不会改变实际访问的网址。
2. **校验消息来源**：`background.js:474-480` 只允许同一扩展 ID、`popup.html` 页面且不是内容脚本的消息触发高权限操作；保留动作白名单和原有参数校验。
3. **隔离本地存储**：`background.js:556-566` 在工作线程启动时调用 `chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`，并保留异常情况下的定时任务恢复逻辑。
4. **显式最小 CSP**：`manifest.json:30-32` 增加 `script-src 'self'; object-src 'self'`。未添加任何第三方脚本、主机权限或动态代码能力。
5. **版本、文档和防误提交**：将版本升至 3.0.1，同步调整弹窗文字和说明，添加 `.gitignore` 忽略环境文件、Chrome 签名私钥、CRX 及未来可能生成的 `node_modules`、`dist` 等。
6. **补充回归测试**：新增 `tests/security.test.cjs`，使用 Node.js 内置测试框架与 Chrome API 模拟，不引入任何外部依赖。

保留的功能：原有网址与间隔保存、后台标签打开、定时关闭、多网址、自动刷新当前标签/整个窗口、任务日志筛选和隐藏、停止循环；对旧版 `timerSettingsV2` 等存储键未做破坏性变更。

## 4. 开发者需要做选择的项目

### SEC-05：允许带鉴权参数的网址吗？

- **方案 A（兼容性优先，当前保留）**：允许任何合法 HTTP/HTTPS URL，在 `storage.local` 保存完整地址以便重复访问；告知用户不要输入带访问令牌/密码的地址，最好只使用网站主页或不包含凭据的链接。**建议当前选择**。
- **方案 B（严格安全）**：拒绝包含查询参数中 `token`、`access_token`、`key`、`password` 等高危字段的 URL；可能导致原先依赖带参链接的工作流失效，需开发者批准。
- **方案 C（进一步隔离）**：只允许指定域名/URL 模式，使用短会话配置替代长期保存；改变可配置任意网址的产品功能，需重新设计。

### SEC-06：历史日志怎么处理？

- **方案 A（推荐）**：用户在升级后手动点击「清空日志」一次，避免旧 URL、标题继续存储；清理前需要先备份确有必要的排障证据。
- **方案 B**：在升级钩子中自动清理 V3.0 日志；会删除用户历史数据，**本次未擅自执行**。
- **方案 C**：保留历史日志，只对将来追加的日志脱敏；隐私残余风险继续存在。

### SEC-08：跨更新保留临时页面的关闭任务？

- **方案 A（兼容性优先，当前保留）**：扩展更新、重新加载时提示用户检查可能遗留的临时网页；避免错误关闭正常页面。
- **方案 B**：把“插件创建的标签”元数据持久化，在扩展重启时用窗口/标签标识等信息重建追踪；需增加对已复用标签 ID 的严格校验，属于业务逻辑改动，本次未改。

## 5. 密钥与凭据扫描

- 已在源码、JSON、CSS、HTML、说明文本及文件名中检索常见 API Key、`Bearer` Token、AWS AccessKey、GitHub Token、私钥头、Webhook、数据库口令特征，**未发现确认的硬编码真实密钥**。
- 示例 `https://www.facebook.com/` 不是密钥。`crypto.randomUUID()` 生成日志/任务 ID，不用于加密。
- ZIP 没有 `.env`、`.env.example`、证书/私钥，也没有 `.git` 历史。因为并未发现实际凭据迁移需求，**没有创建无意义的 `.env.example`**。
- 若开发者曾在其他版本、私有仓库、历史构建或公开渠道中暴露密钥，必须到对应平台**作废并重新生成**；仅删除文件或代码不等于密钥已经失效。

## 6. 测试和验证记录

| 项目 | 结果 |
|---|---|
| ZIP 静态成员检查（路径穿越、symlink、文件尺寸） | 通过 |
| JS 静态语法检查 `node --check background.js` | 通过 |
| JS 静态语法检查 `node --check popup.js` | 通过 |
| Manifest JSON 解析、权限、CSP 断言 | 通过 |
| Node.js 回归 `node --test tests/security.test.cjs` | **6 / 6 通过** |
| 危险协议与含用户名密码 URL 拒绝 | 通过模拟测试 |
| 跨页面来源消息拒绝 | 通过模拟测试 |
| 自动打开、关闭、排除插件临时页和刷新 | 通过模拟测试 |
| 日志对含 token URL、页面标题的脱敏 | 通过模拟测试 |
| 真正的 Chrome 120+ 端到端运行 | **待确认**：尝试在沙箱 Chromium 中载入扩展，后台工作线程未能正常启动或执行超时；不能以模拟测试取代真实环境验收 |
| 原有构建 / 既有测试 | 项目未附带，无法运行；已补充 Node 原生测试 |
| 第三方包漏洞扫描（npm/pip/cargo 等） | 不适用：0 个第三方包、无依赖清单 |

手工验收建议：Chrome 中升级相同目录并「重新加载」，检查已经保存的设置仍存在；用 `https://example.com` 测试后台新标签页 3–5 秒自动关闭；启动固定标签/当前窗口刷新；验证日志隐藏与清空；Chrome 重启后验证刷新任务不误绑定旧标签，检查新日志没有敏感参数。

## 7. 剩余风险 / 后续建议

- 自动刷新窗口内所有网页可令未保存表单丢失；属于显式用户选择，继续保持原功能，并在界面提示。敏感管理网站建议只用“固定标签页”。
- 无需添加 `host_permissions` 或 `<all_urls>`。`tabs` 权限仍较广，若以后重构为仅刷新用户标记的 tab，可评估缩小权限，但本次不能无损去除。
- Chrome MV3 Service Worker 会挂起，数秒自动关闭使用内存 `setTimeout` 和 `chrome.alarms` 兜底；在休眠/线程回收时不保证秒级精准。Chrome 120+ 的 alarm 机制通常最短约 30 秒。此为浏览器生命周期限制而非自动精确定时保证。
- 无真实 git 历史，无法对历史提交中的密钥进行完整追溯；建议在实际 Git 仓库内启用 Secret Scanning，并定期审查扩展权限和新的依赖。
- 如用户决定使用包含账号令牌的链接，需额外设计凭据生命周期和存储策略，不宜依赖明文 URL 持久化。

## 8. 主要参考（官方文档）

- Chrome Extensions Storage： https://developer.chrome.com/docs/extensions/reference/api/storage
- Chrome Extensions Message Passing： https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- Chrome Extensions Tabs： https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome Extensions Service Worker Lifecycle： https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

**说明：** 本报告为审阅上传 ZIP 的静态代码及模拟测试结果，未进行线上真实业务环境渗透、资产扫描或仓库历史检查，因此不提供“绝对无漏洞”的保证。
