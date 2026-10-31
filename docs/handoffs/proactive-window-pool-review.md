# Proactive 优化交接：窗口池、新闻推送、系统通知

日期：2026-10-31
分支：`feat/proactive-window-pool`，基于 `v1.0.0dev` @ `62a3fa73`
状态：**未推送、未合入。** 6 个提交，38 个文件，+934 / −41。主工作区 `v1.0.0dev` 未改动。
Worktree：`~/sqxh/nova-proactive-window`

## 一句话

工作台原来是「证据一变就立刻让模型判一次」，新闻只排序不提醒，桌面端没有系统通知。这一批改成：来源证据先进窗口再整批判定，新闻单独一条推送车道，并加上桌面系统通知。

## 请你重点看的

1. **窗口与去重的并发边界**（`runtime/src/personal-agent/host.ts` 的 `#drainSources`、`discoverLatest`、`discover`）。窗口到期时若已有一次发现在跑，会等它结束后补一轮。这是并发最密的地方。
2. **新闻额度的两处记账**（`admitNews` 入库时按本地日数 feed 项；`notificationValidity` 投递时按已送达数）。两处口径不同是有意的，请确认没有漏洞。
3. **桌面端「新到达」的判定**（`clients/desktop/src/renderer/proactive-notify.mjs`）。用 `created_at` 与渲染进程本机时钟比较，见下面的假设。
4. **`discover` 的返回契约变了**：从单个提案变成数组。旧形状 `{proposal:…}` 现在会被当作沉默。

## 改了什么

| 提交 | 内容 |
|---|---|
| `34ca08de` | 多对一窗口池；一次发现 1 到 3 条提案；快照带今日剩余额度 |
| `114e0e8a` | 评审修复：窗口触发时已有发现在跑要补跑；同一件事的提问和通知只放行第一条 |
| `bc3b4d1f` | 桌面系统通知（主进程 `system-notifier.mjs`、渲染端检测器、设置卡） |
| `58253865` | 新闻推送车道：独立类别、每天 2 条独立额度 |
| `85860835` | 评审修复：新闻按文章身份去重、按发布时间过期、投递前复核开关；检测器不再把历史当新消息 |
| `4f395f60` | 简报时间落在免打扰时段则拒绝保存；英文词条；文档对齐 |

### 1. 多对一窗口池

- 新文件 `runtime/src/personal-agent/discovery-window.ts`：`touch()` 在最后一条到达后静默 3 分钟触发，或从第一条起满 15 分钟强制触发；`quietMs` 为 0 时同步触发并把错误传回调用方（旧测试夹具依赖这一点）。
- `host.ts`：`#drainSources` 不再每次签名变化就 `await discover()`，改为记录签名并 `touch()` 窗口；`close()` 取消窗口；`touch()` 前检查宿主仍是打开状态。
- `discover` 一次最多放行 3 个提案；证据或记忆引用重叠的视为同一件事，只放行第一条。
- `proactivity.ts`：模型返回 `{proposals:[...]}`，单个不合格的提案只丢这一条。prompt 要求「窗口里的内容整体判断，相关的合并成一条，额度少时只留不能等的」。快照新增 `daily_budget_remaining`。
- **默认值写在代码里**（3 分钟 / 15 分钟），设置页还不能调。

### 2. 新闻推送车道

- `NewsService.pushCandidates()`：只取已确认兴趣（不含从画像猜出的）、发布不满 24 小时、`substance` 不是 thin 或 promotional、加权匹配度 ≥ 0.85 的文章，按强度排序。每批排序保存后触发 `ranked()`。
- `host.admitNews()`：生成 `kind:'notify'`、`subject_key:'news:<id>'`、`source.type:'news'` 的 feed 项，沿用现有链路进入 `chat:main`。去重键是文章 id（不含内容哈希）；过期时间是发布时间加 24 小时；`discovery_enabled` 关闭时不入库。
- 通知类别新增 `news`，每天 2 条（`NEWS_DAILY_CAP`），**不占**简报与建议共用的 `proactive_daily_cap`。
- 投递前复核：发现开关、资讯开关、过期时间。

### 3. 桌面系统通知

- `main/system-notifier.mjs`：只有窗口不是「可见且聚焦」时才弹；一批合并成一条，标题列前 3 个；按消息 id 去重，集合上限 1024；点击走 `requestPresentation('workbench',{attention:true})`，即托盘点击的同一条路径。
- 渲染端 `proactive-notify.mjs` 在每次快照变化时检测新的 `origin:'proactive'` 未读消息，经 IPC `nova:personal:notify` 发给主进程。
- 新增桌面本地设置 `systemNotifications`（默认开，不发给后端）和设置卡。
- **权限处理**：Electron 没有读取通知权限的 API，所以设置卡只报告平台实际反馈的状态（未确认 / 正常 / 失败），失败时提示去哪里改并提供「打开系统通知设置」。`failed` 事件只在 macOS 和 Windows 有，Linux 只能显示「未确认」。
- 四个新 IPC 通道已登记进 `main-security.test.mjs` 的白名单断言；`event.sender` 校验与现有通道一致。

### 4. 简报与免打扰

- `briefQuietConflicts()`（`daily-brief.ts`）：已开启且时间落在免打扰内的简报。`discovery.configure` 在保存会改动 `briefing_*` 或 `quiet_*` 字段时校验并抛 `brief_in_quiet_hours`。只在改动这些字段时校验，所以磁盘上已有的旧冲突不会妨碍改别的设置。
- 设置页（旧 mjs 表单和 React 面板）保存前先预检，文案已进 `host-refusals.mjs` 和英文词条。

### 5. 文档

`docs/zh-CN/workbench.md`、`docs/en/workbench.md` 更正了设置路径（实际在「日记与简报」）、删去不存在的时区设置，并新增「提醒如何到达」一节；`docs/specs/v0.3.0/02-need-discovery-and-feed.md` 末尾追加 2026-10-31 修订，说明主对话交付取代了旧的「固定主动提醒会话」。

## 验证情况

做过：

- runtime 逐文件回归（每个文件独立进程、硬超时）：386 个文件，**4 个失败，都在未改动的基线 `62a3fa73` 上同样失败**：`mem0-store`、`memory-diary`、`notification-store-upgrade`、`personal-store-upgrade`。
- 桌面端：160 个 node 测试文件仅 `react-build` 失败（未改动的主工作区同样失败，系统临时目录问题；用缓存目录作 `TMPDIR` 时通过）；React 测试 14 个文件 0 失败；渲染端类型检查通过。
- runtime 类型检查、改动文件的 eslint 通过。
- 新增测试 62 个：窗口 6 + host 层 6，新闻 14，简报冲突 5，桌面系统通知 12 + 视图 7 + 检测器 9 + 简报预检 3。
- **变异验证**：关键逻辑（窗口取消、提案上限、同事项合并、补跑标记、新闻两处额度、身份去重、发布时间过期、投递复核、检测器时间门限、免打扰校验两处）都各自改坏过一次，确认对应测试会变红，再还原。
- Codex 对抗评审 2 轮，共 7 条意见，逐条对照代码后全部成立并已修。
- 一个例外：评审的「关闭后来源处理仍可能重装计时器」一条，我没能写出稳定复现的测试（做变异后测试仍通过，说明抓不到回归），所以删掉了测试，**该修复只靠代码阅读和评审意见，没有测试保护**。位置：`#drainSources` 里 `touch()` 前的 `this.#opened` 检查。

**没做过：**

- **没有任何真机验证。** 窗口池在真实飞书消息下的行为、系统通知的实际弹出和点击、权限被拒时面板显示、最小化到托盘时能否弹出，都只有单测。
- 没有运行完整的桌面端构建（`build.mjs` 会重编 mem0 原生模块，与本改动无关且可能写共享位置）。
- 没有在 macOS 以外的平台验证系统通知。

## 假设与已知限制

- **时钟假设**：检测器用消息的 `created_at` 与渲染进程的本机时钟比较。桌面端后端和界面在同一台机器上所以成立；如果以后后端跑在另一台机器上，时钟偏差会导致漏发或多发通知。
- **Windows 的 AppUserModelID**：主进程设置的是 `ai.deepnovacore.nova-audio-agent.orb`，我没核对它是否与 Windows 通知所需的一致。
- **未签名的开发版 Electron 在 macOS 上可能弹不出通知**，这时设置卡应显示「失败」。
- **`state.dedupe` 每推一篇新闻多一个键**，我没有给它加上限（简报同样如此），量级是每天最多 2 个。
- **discover 一次最多 3 条**是产品决定，不是技术上限。
- 新闻推送只在「已确认兴趣」下工作；兴趣是从画像猜出来的、用户没确认过时不推送。

## 怎么跑

构建输出请按 `AGENTS.md` 放在内部存储并按 worktree 隔离，不要写共享的 `runtime/dist`。本分支的 worktree 在 `~/sqxh/nova-proactive-window`，`runtime/dist` 是它私有的。

```bash
cd ~/sqxh/nova-proactive-window/runtime
npx tsc -p tsconfig.json          # 构建到本 worktree 的 dist
node --test --test-timeout=60000 dist/test/discovery-window.test.js dist/test/news-proactive.test.js dist/test/brief-quiet-conflict.test.js dist/test/personal-agent.test.js dist/test/model-adapters.test.js

cd ../clients/desktop
node --test test/system-notifier.test.mjs test/proactive-notify.test.mjs test/system-notifications-view.test.mjs test/brief-quiet.test.mjs test/main-security.test.mjs
```

注意：
- macOS 没有 `timeout` 命令；用 `node --test --test-timeout=…`。
- 依赖夹具 JSON 的测试（如 `personal-agent.test.js`）必须在 worktree 内的 `runtime/dist` 里跑，输出到别处会因相对路径找不到夹具而失败。
- 一次性并行跑完整套件时，崩掉的 mem0 原生模块子进程可能让父进程不退出；逐文件跑并给每个文件加硬超时更可靠。

## 真机验证清单

1. 开着工作台时从飞书发几条连续消息：应在最后一条后约 3 分钟收到一次合并的提醒，而不是每条一次。
2. 把工作台最小化或切到别的应用，再触发一条提醒：应弹出系统通知；点击回到工作台并定位到主对话里的未读消息。
3. 工作台在前台且聚焦时触发提醒：**不应**弹系统通知。
4. 在设置里关闭「弹出系统通知」：不弹，再打开后不重放期间的消息。
5. 在系统设置里禁用 Nova 的通知后触发提醒：设置卡应显示「失败」并给出去哪里改；从系统设置回到应用时自动刷新状态。
6. 添加一个确认过的兴趣，等新闻刷新排序：高匹配的新闻应出现在主对话，每天最多 2 条；关闭「主动发现」后不再推送。
7. 设置早间简报为 07:30（默认免打扰到 08:00）并保存：应被拒绝并提示原因。
8. 重启后确认没有把昨晚的未读提醒一次性弹出来。

## 不在本次范围

内建周报、待办和日程的定点提醒、用户对提醒的反馈回流（忽略 / 点赞）、窗口大小的设置项、移动端（Flutter）的对应改动。
