# Mobile handoff — thinking, Space UX, voice, connectors, tab transitions

> **2026-10-30 最新接手入口：[移动端飞书质量迁移交接](docs/handoffs/mobile-feishu-quality-next.md)。** Android build 18 已生成卡片，但主体归属内容验收失败；功能分支未合入、未 push。下文保留历史快照，以新交接现状和优先级为准。

Date: 2026-10-29  
Worktree: `<worktree>`
Branch: `fix/mobile-thinking-and-pages`  
Base: `v1.0.0dev` @ `90d0e10a`  
Code HEAD: `c33f0224` (this handoff is a docs-only commit after it)  
Status: **not pushed, not merged**; main checkout `90d0e10a` unchanged; worktree was clean before this doc.

## TL;DR

Five commits implement the agreed mobile fixes:

1. Keep model thinking enabled on both PC and mobile; show a collapsible thinking block (collapsed by default), persist/replay reasoning correctly, and fix Space/profile empty states.
2. Remove duplicate tab titles and refine the Space strip.
3. Simplify voice settings: official endpoints, model/voice dropdowns, realtime vs step-by-step as two tabs (no "advanced" fold).
4. Add a Connectors page (Feishu + system calendar/reminders), and fix Feishu existing-app binding by using Feishu's web app chooser instead of a create-only page.
5. Remove the bottom tab-bar backdrop blur and add opaque backgrounds to pushed pages, to stop iOS tab/page ghosting.

Review focus: **Feishu existing-app web flow** (still needs real-device confirmation), **voice config migration/key semantics**, and **ghosting fix trade-off**.

## How to inspect

```bash
cd /Users/fishwowater/sqxh/nova-audio-agent/.agents/worktrees/fix/mobile-thinking-and-pages
git log --oneline v1.0.0dev..HEAD
git diff v1.0.0dev...HEAD --stat
git show <commit>
```

Flutter verification:

```bash
cd clients/flutter
flutter analyze --no-pub
flutter test --no-pub
```

Expected: `No issues found!`; **1072 passed / 5 skipped** (current code HEAD).

## Commit map

| Commit | Scope | Summary |
|---|---|---|
| `cc60c7e8` | PC | Enable Build reasoning capture by default (`build_reasoning` / desktop `buildReasoning`) and update tests. |
| `ee8145b2` | Mobile + iOS | Reasoning streaming/display/persistence, collapsed thinking block, Space top inset, saved profile/timeline loading, precise empty states. |
| `b26ce378` | Mobile UI | Drop duplicate tab titles; Me keeps a gear-only bar; open task keeps back only; refine Space strip typography/letter spacing/switch. |
| `afb903bb` | Mobile | Voice settings (official endpoints, dropdown catalogs), Connectors page, Feishu create/manual entry paths, remove bottom `BackdropFilter`, opaque pushed pages, tests/goldens. |
| `c33f0224` | Mobile | Feishu CLI web app chooser (`/page/cli?...&from=cli`), profile copy/actions now "连接器", About-me copy, realtime/step-by-step voice tabs, tests/goldens. |

Total across the branch: 66 files, +4295 / −638 (including goldens).

## What changed, per area

### 1. Thinking / reasoning (`cc60c7e8`, `ee8145b2`)

- DeepSeek Chat Completions thinking stays **enabled** on PC and mobile; no `thinking: disabled` / `enable_thinking:false` was added for chat. Voice cascade and profile budget keep explicit `disableThinking: true` for latency/budget.
- `model_client.dart` parses `reasoning_content` / `reasoning`, counts it toward output budget, emits it as `reasoning`, and replays DeepSeek assistant `reasoning_content` when tools are present (legacy assistant messages get `''`; other hosts strip it).
- iOS native parser (`ModelStreamParser.swift`) and `IosModelClient` forward reasoning; `AgentCoreHost` accumulates/resets per round, stores it on assistant/tool-call/interrupted messages, checkpoints it; conversation recovery restores it.
- UI: new `thinking_block.dart` — collapsed by default, header "思考/正在思考", one-line summary, elapsed, expandable selectable text (max height 320). Live `ChatActivity` shows summary/details; persisted assistant/tool-call turns show the block above content; interrupted turns keep partial reasoning.
- Space/profile: standalone subtree consumes the top inset only once (`MediaQuery.removePadding`); `FeishuHost.restored` lets local profile/timeline render while sources are still opening; empty states now distinguish opening failure, not restored, no stored result, generation status, and configured/authorized/syncing causes.
- PC: `runtime/src/config/config.ts` and desktop `settings-defaults.mjs` default to capturing Build reasoning.

### 2. Tab titles and Space strip (`b26ce378`)

- Tasks list and Timeline root no longer have an AppBar/title; the bottom tab bar names them.
- Me has a compact gear-only top bar; an open task chat has only a back button.
- Nova keeps the avatar + "Nova" title (brand/home, not a tab label).
- Space strip: explicit styles/letter spacing for name and "独立运行", compact Space switch, 0.5px separator; smaller vertical padding.
- Goldens updated for the shell.

### 3. Voice settings (`afb903bb`, redesigned in `c33f0224`)

- Built-in integrated providers always use their official WSS endpoint; the endpoint is no longer shown or editable. Historical custom endpoints are normalized to official (user-approved), with an inline notice if that means the saved key must be re-entered.
- Provider catalogs copied from PC:
  - Qwen models 3.1/3.0/3.0-flash/omni; voices by model (3.1 → `longanqian_v3.1`, omni → `Ethan`, default → `longanqian` list).
  - StepFun `stepaudio-3-realtime-preview` + `default`.
  - OpenAI `gpt-realtime-2.1-mini` / `gpt-realtime-2.1` + `marin/cedar/alloy/coral`.
  - Gemini `gemini-3.8-live` + `Kore/Puck/Aoede/Charon/Fenrir`.
- Realtime vs step-by-step are now two clear tabs/segmented tabs at the top. The selected tab is the pipeline; only that pipeline's fields render. Realtime tab: provider/model/voice/API key. Step-by-step tab: existing ASR/fast-LLM/TTS fields (functionally unchanged; endpoints for those advanced stages are still visible).
- No advanced fold, no duplicate "语音模式" dropdown, no overlapping headings; API-key helper shortened; new/edited labels are bilingual.
- Saved model/voice values absent from the catalog are kept as extra dropdown options (no free text). Provider change resets defaults and key input; model change resets the default voice.
- `VoiceSettings` validation/merge semantics were not changed: blank key is retained only when provider and endpoint match; changing endpoint requires re-entering the key.

### 4. Connectors and Feishu (`afb903bb`, `c33f0224`)

- Settings "更多 → 飞书" is now **Connectors**; new `ConnectorsPage`:
  - Feishu row: status chip (reading / not connected / waiting for authorization / syncing / connected), subtitle, opens the existing `FeishuDirectPage`.
  - System row: Calendar & reminders, read-only, permission requested on first in-chat use.
  - Footer: read-only authorization, more connectors later.
- Feishu setup now offers:
  - **通过飞书网页绑定** (web app chooser).
  - **手动绑定已有应用** (App ID + Secret) as fallback; validation `cli_` + non-empty secret; page-owned busy state so a running message sync does not block it.
- **Existing-app web flow**: The registration API returns `verification_uri_complete` on `/page/launcher`, but that page is create-only ("创建飞书智能体应用"). `c33f0224` instead opens Feishu's CLI configuration page with the same device code:
  `https://open.feishu.cn/page/cli?user_code=<code>&lpv=1.0.97&ocv=1.0.97&from=cli`
  This is the page lark-cli uses; it carries the "新建应用 / 选择已有应用" branch. Server URL is validated against official Feishu/Lark hosts; untrusted URLs are rejected. **Real-account end-to-end confirmation is still pending** (see open questions).
- Profile page copy now says Connectors instead of Feishu: empty hints, "Open connectors" button (opens the Connectors page), and About-me footer ("Information from connected sources appears below." / "连接器整理的信息会显示在下方。").

### 5. iOS tab/page ghosting (`afb903bb`)

- Root cause hypothesis: the only `BackdropFilter` (20px blur) in the app was the bottom tab bar; iOS/Impeller can keep stale backdrop samples when the content behind it changes, and transparent pushed routes can show through during transitions.
- Fix:
  - Removed `ClipRect` + `BackdropFilter` + `ImageFilter`; tab bar is now opaque `Nova.ink` with the 0.5px top hairline (height/icons/labels unchanged).
  - `_workspace` Scaffold background `Nova.sheet`; Feishu page `Nova.ink`; local tasks page `Nova.ink`; `NovaPage` was already opaque.
  - No new tab animation; `IndexedStack` semantics unchanged.
- Goldens updated; shell test asserts no `BackdropFilter` remains.
- **Device visual confirmation pending**; if ghosting persists, next step is a screen recording + an Impeller-disabled diagnostic build (not committed).

## Key files

- Thinking: `clients/flutter/lib/ui/thinking_block.dart`, `chat_activity.dart`, `conversation/local_chat_panel.dart`, `agent_core/model_client.dart`, `agent_core/agent_core_host.dart`, `ios/Runner/ModelStreamParser.swift`.
- Space/profile: `space/space_root.dart`, `connectors/feishu/host.dart`, `context/profile_repository.dart`, `ui/local_profile_results.dart`, `ui/profile_generation_status.dart`, `ui/app.dart`.
- Voice: `voice/voice_settings.dart`, `voice/voice_settings_sheet.dart`.
- Connectors/Feishu: `ui/connectors_page.dart`, `ui/feishu_direct_page.dart`, `connectors/feishu/app_registration.dart`, `connectors/feishu/api.dart`.
- PC default: `runtime/src/config/config.ts`, `clients/desktop/src/main/settings-defaults.mjs`.
- Tests: `test/model_reasoning_test.dart`, `test/chat_reasoning_test.dart`, `test/feishu_host_restore_test.dart`, `test/profile_empty_hint_test.dart`, `test/voice_settings_sheet_test.dart`, `test/connectors_page_test.dart`, `test/feishu_app_registration_test.dart`, plus updated profile/space/navigation tests and goldens.

## Verification evidence

- Flutter: `flutter analyze --no-pub` clean; `flutter test --no-pub` **1072 passed / 5 skipped** at `c33f0224`.
- iOS native parser self-check: `ModelStreamChecks.swift` updated and previously run in the first round.
- PC: `cc60c7e8` was verified with the PC suites at that time (**88 runtime + 252 desktop tests passed**). No PC code outside that commit changed in this branch; rerun if policy/docs need fresh evidence.
- Device: Apple build **1.0.0 (5)** is installed on the test iPhone (iOS 26.6) and launched; data was preserved. The acceptance build temporarily strips Push/App Groups entitlements (personal team limitation); source entitlements are restored and not committed.
- Build toolchain: Xcode 16.4 plus the mounted iOS 18.5 Simulator runtime at `/Volumes/iOS 18.5 Simulator` (must stay mounted for device builds); outputs are on the external volume. The official/TestFlight build should be reinstalled after acceptance.
- No push/merge; main worktree's pre-existing changes were not touched.

## Known risks / open questions for reviewers

1. **Feishu existing-app web chooser is unverified on a real tenant.** The new `/page/cli?...&from=cli` URL is the lark-cli one-click page; if the phone still shows only create, we need a different web/API flow. The `lpv=1.0.97&ocv=1.0.97` values are copied from lark-cli and are a maintenance risk.
2. **Feishu CLI page is an undocumented surface.** Security/product should confirm it is acceptable; manual App ID/Secret remains as a fallback.
3. **Official endpoint normalization** changes historical custom endpoints for built-in providers (user-approved). A saved key for the old endpoint is not reused; the sheet tells the user to re-enter it.
4. **Ghosting fix is a hypothesis.** Removing the blur is visually minimal but needs real-device confirmation; if it persists, investigate Impeller vs route backgrounds.
5. **Acceptance build lacks Push/App Groups.** Reinstall the official/TestFlight app after device acceptance.
6. **PC settings migration and Client↔Host settings sync are recommendations only** (see below); no protocol code was added.

## Recommendations carried over from the review discussion

- Mobile settings should stay lean: Model, Voice, Connectors, Language, Phone schedules, Activity, Local data. Do not clone the PC settings tree.
- Client mode: Host projections are authoritative; reading is via snapshot and writes via intents. A future phase can sync an allowlisted, non-secret subset (model/voice/connector status) Host→Client read and Client→Host write; keep language/avatar/notifications local; API keys write-only; no executors/MCP/paths/developer settings. This is a protocol/authority change (medium-high cost), not part of this branch.

## Suggested reviewer checklist

- [ ] Feishu URL construction: official-host validation, no secrets, manual fallback, `from=cli` page choice; try with a real Feishu tenant and confirm "选择已有应用" appears and binds.
- [ ] Voice: tab save semantics, provider/model/voice defaults, catalog correctness, official endpoint normalization + key re-entry, no overflow at 390px, cascaded behavior unchanged.
- [ ] Profile/Connectors copy and action routing.
- [ ] Ghosting: tab/page transitions on a real iPhone; if not fixed, gather a recording.
- [ ] Thinking: DeepSeek reasoning replay only for DeepSeek; legacy/non-DeepSeek hosts strip it; collapsed-by-default UI.
- [ ] Tests/goldens: full suite, no accidental changes in golden content beyond intended UI/copy.
- [ ] PC default reasoning change and whether the default is intended.

## Next steps

1. User verifies Feishu existing-app chooser on build 5; if still create-only, switch to a different Feishu web-login/app-list flow.
2. User verifies voice tabs, profile Connectors copy, and tab/page ghosting on the iPhone.
3. If accepted, reinstall official/TestFlight build; keep this branch for review/merge decisions (not pushed).
4. Separate follow-up: Client↔Host allowlisted settings sync design, and any PC settings migration items if desired.


## 2026-10-29 复核、修复与本地合入

已将 `fix/mobile-thinking-and-pages` 合入本地 `v1.0.0dev`，合并提交 `966a20f2`，代码候选为 `6246f9e5`。没有 push。功能分支与 worktree 保留。初始交接之后完成了以下独立提交：

| 提交 | 结果 |
| --- | --- |
| `b2b6e909` | 将仅读取承诺限定在飞书；日历/提醒事项说明读取、按明确请求创建和更新，以及系统设置中的权限管理。 |
| `3ea26f0e` | DeepSeek 思考请求的总输出预算改为 65,536 tokens，避免思考挤占源码预算；后台关闭思考时仍为 12,000。原生长度错误前也发送已解析的思考批次，保留中断内容。 |
| `2eec68c9` | 语音页改为「端到端 / 级联」，移除 ASR 重复标题；「前脑」复用模型服务预置厂商。空密钥只在同 Space、相同规范化 API 地址下读取现有模型 API key，在内存使用，不复制入语音配置；已保存的显式语音密钥优先。 |
| `6246f9e5` | 一轮用户请求内，同一 HTML 路径只展示最后一次成功作品卡片；不同文件和较早用户轮次保留。读取和失败编辑不生成或覆盖卡片，完整工具/模型历史不变。 |

### 独立验证

- Flutter analyze 无问题；最终全量测试 **1075 通过 / 5 跳过 / 0 失败**，覆盖 goldens。
- runtime workbench 定向 **88/88** 通过；合并后重跑桌面 settings/defaults/backend、权限、renderer 构建、React 设置、语言与翻译覆盖套件。
- iOS 原生 SSE parser 自检通过。额外私有自检直接执行实际 `NativeModelTransfer`，只替换 Flutter/UI 框架边界：同批次返回思考后立即触发长度错误，原实现失败，修复后通过。该项属于原生类模拟边界验证，不是网络或真机证明。
- 语音密钥复用曾在切换 Space 时复现读到另一 Space 密钥；构造时固定模型设置作用域后，A/B 切换、读取、保存、密钥缺失、轮换、删除与地址隔离回归通过。
- 卡片回归先复现重复，修复后验证最新成功卡片的位置、不同路径、跨用户轮次、失败编辑、读取排除、点击打开及存储内容不变。
- 最终候选的 340 个 Flutter/iOS 源码和测试文件与构建副本一致；依赖缓存实际版本与原 worktree 一致。合并后的 Flutter/runtime 文件树与该候选一致。

### iPhone 验收（独立运行）

候选 **1.0.0 (7)** 已完整 Xcode 编译、签名检查、原地安装并启动，保留原 bundle、Team、默认 Keychain 和业务数据。现有个人签名验收包能力沿用 build 5：没有 Push/App Groups 验收；源码 entitlements 未因此修改。

- 用户在真实 DeepSeek `deepseek-flash` 上提交基础俄罗斯方块任务，生成了可打开的页面，本轮未再出现输出长度错误。代理实际打开游戏并操作开始、移动、旋转和落下，观察到方块落地与分数变化。任务自带浏览器检查最终通过，过程中保留了检查失败及后续修正记录。
- 用户确认思考内容后续可见；build 7 升级后再次确认旧思考仍在，重复的 `index.html` 作品卡片只剩一张。build 6→7 的完整对话 JSON 对象比对一致。
- 最初未收到可展示内容时仍显示等待模型输出。没有记录本次首片回调时点，因此尚未把这段等待归因于模型首字延迟或 iOS 网络批次；不将完整一轮的落盘耗时当作首 token 延迟。
- 真机观察到「端到端 / 级联」、单一 ASR 配置、前脑预置厂商列表；选择 DeepSeek 后自动填入 `deepseek-flash`。密钥复用/保存/重开语义的结论来自回归测试；没有进行真实语音通话。
- 官方飞书网页在当前已登录租户中，向下滚动后实际显示「选择已有应用」。手动绑定入口可见。本次没有创建或绑定应用，临时注册流程已取消；完整绑定授权仍未执行。
- 简单标签页与页面进出未观察到持续残影；这不建立所有设备上的根因结论。

私有原始证据、业务数据备份、完整日志和构建产物留在本次外接盘验收目录，未加入 Git。初次全 Library 备份被系统保护的界面恢复文件挡住，随后分别完成 Application Support、Preferences 和 Documents 备份；没有把受保护 UI 状态或系统 Keychain 导出说成已完成。初次隔离 Flutter 测试因漏复制跨目录 fixtures 失败，补齐后全量通过，旧日志保留。原生路径未保存完整供应商 usage，费用不作精确账单声明。

### 主工作区既有改动

按用户要求分成五个本地提交，原内容逐文件校验保留：权限入口 `c6838940`、renderer 默认构建路径 `122531a1`、旧手机设置链接回归 `126bbdf9`、英文消息表 `c92bb801`、历史评审记录 `b183a3de`。用户确认 direction 文档的旧决策回退并非有意，已恢复与既有 Handoff 一致的 D22/D24/D25 表述，原回退副本私下保留。


## 2026-10-29 模型与语音密钥统一配置

代码提交 `550a5dcb`（基于 `v1.0.0dev` / `9659d914`），本地验收包 **1.0.0 (8)**。

- 模型服务新增统一的服务密钥管理入口，可同时保存多个厂商；给语音添加或修改厂商不会切换当前聊天模型。ChatGPT 登录页也保留管理入口，OAuth 凭据不用于语音 API。
- 端到端、级联和语音输入设置均移除 API 密钥输入框，只展示配置状态与「去模型服务配置」。模型、音色、服务地址和 Resource ID 仍在对应语音配置中编辑。
- 模型与语音配置保存凭据引用，运行时解析安全存储中的密钥。旧配置按当前 Space 自动迁移；同厂商旧密钥有冲突时分别保留对应引用，迁移先保存完整注册表再替换旧记录。已删除或缺失的显式引用不会回退到其他密钥；自定义服务按精确地址隔离，仅已知官方路由共享。
- 独立 review 发现并修复：编辑其他厂商会多尝试刷新当前原生模型，可能被活跃任务拒绝。回归使用新的 ModelSettings 实例和活跃任务拒绝桩，先失败、修复后通过；现在仅更新当前聊天实际引用的密钥时才投影到原生。
- 最终 Flutter analyze 无问题；完整测试 **1086 通过 / 5 跳过 / 0 失败**，包含旧数据迁移、并发、失败保留、厂商切换、轮换、Space 隔离和小屏大字体界面回归。
- build 8 完整 Xcode 编译、同一验收签名校验、原地安装、启动及设备版本回读通过。生成的 Swift package 临时最低 iOS 版本与项目既有 iOS 17 对齐；源码部署目标未修改。沿用 build 5–7 的个人签名能力，不包含 Push/App Groups 验收。
- 升级前完成 Documents、Preferences，以及当前 Space 对话、任务、日志和作品目录备份。全 Application Support 复制被 Linux workspace 链接挡住，随后逐项备份当前 Space 所需目录；未把 Linux 根文件系统或系统 Keychain 说成完整备份。升级前后当前 Space 的完整对话 JSON 对象一致。
- 本轮未执行真实语音通话或新增模型调用；厂商密钥复用与迁移语义的结论来自回归测试。用户随后确认 build 8 配置界面无问题。


## 2026-10-29 后台模型、工具过程与全局设置

代码提交 `54248094`，基于已验收的统一密钥实现。用户选定只对齐手机已落地的模型用途。

- 端到端、ASR、前脑和 TTS 明确显示密钥已配置／未配置／读取中／读取失败，已配置用绿色标识；状态不等于供应商连接或额度验证。
- 对照 PC 模型路由增加「辅助与后台模型」，默认跟随对话，也能独立选择预置厂商和模型，复用中央凭据。飞书整理、Profile 和近况生成的实际调用、授权检查和模型身份读取均接入该用途；不添加没有手机消费者的 PC 功能入口。
- 配置或 OAuth 选择变化会通知当前 Space 的后台任务；运行中的旧任务取消并拒绝发布过期结果。后台用途保存不切换聊天模型，也不把独立后台 API 配置投影到原生聊天。
- 手机聊天按消息顺序显示思考、正常解释和工具结果条目，可展开安全元数据；不展示原始参数／返回。失败、拒绝、取消及结果待核实分别标记。工具结果落盘后立即通知界面，不等待下一轮模型首字。作品卡片仍按目标与用户轮次去重。
- 独立运行的齿轮进入固定 Space 顶栏，移除「我的」空齿轮栏；Client 的各主 tab 也始终提供设置入口。保留 Space 切换、任务返回和全屏语音导航。
- 独立 review 发现并关闭：后台编辑密钥可能漏刷新原生聊天、未知结果误标失败、OAuth 修改漏发后台失效通知、工具完成漏刷新。第一项通过统一委托中央密钥管理解决。
- 最终 Flutter analyze 无问题，全量 **1095 通过 / 5 跳过 / 0 失败**。覆盖用途隔离、OAuth、跨 Space、生成失效、工具完成后下一轮卡住、历史预览去重、窄屏顶栏和导航。界面 golden 已更新并检查。
- 本轮没有新增真实模型调用或语音通话。build 9 的手机配置、历史工具过程目视验收由用户配合，结果单独续记；自动回归不替代真机现场证明。


build 9 最终验收：完整 Xcode 编译、同一验收签名校验、原地安装和设备回读 **1.0.0 (9)** 通过。自动启动首次被手机锁屏拒绝；用户随后手动打开，并明确确认四项均正常：各 tab 全局设置、语音密钥状态、后台模型入口、旧俄罗斯方块对话中的交错工具条目和作品卡片。build 8→9 当前 Space 的完整对话 JSON 对象一致。

本轮以快进方式本地合入 `v1.0.0dev`，不 push；外置工作区、原始失败日志和私有备份保留。真实语音通话、修改后台模型后的真实飞书处理调用及 Push/App Groups 不作已验收声明。


## 2026-10-29 模型服务、消息显示与飞书增量复核

本轮在 `feat/mobile-provider-credentials` 分组提交，尚待最终真机结果后合入；不 push。当前代码候选 `e55476cd`。

- `387a958d`：统一「模型服务」主入口，下设对话模型、信息整理、语音服务、服务密钥；密钥配置页显示配置状态。相邻工具结果合并成紧凑条目，保留用户、思考及作品边界。
- `936f3fa2`：飞书页改为连接、聊天记录、近况与个人信息卡片；同步使用 spinner，并保留暂停和折叠详情。
- `c22ffb93`：增加本机「消息显示：完整过程 / 简洁」，默认完整。简洁隐藏思考、工具及中间回复，保留最终回复、作品链接、错误和停止操作；不修改原始历史或模型思考参数。聊天初始化先恢复偏好，防止简洁模式短暂显示过程。
- `7af8c9c5`：参照 PC，新窗口倒序；旧正序分页 token 连同起止范围保留。最新增量与历史回填使用独立持久游标；回填期间每 61 秒检查新消息，每轮每对话头部最多两页。保存未完成队列及累计进度，避免恢复时反复从已完成前缀开始。
- 同一提交补齐 text/post/interactive 的有界正文提取、坏记录跳过统计，以及授权恢复。临时刷新失败和同账户重新授权保留缓存；账户绑定代次与异步请求 epoch 分开，旧响应在实际队列执行和持久化完成时均再次校验。授权变化时恢复旧快照再返回失败；若恢复写入自身失败，错误继续传播，不发布新内存状态。
- `00f9d0bc`：新增按原始消息身份及内容指纹保存的加密观察清单。新增内容复用未变批次，编辑或删除使受影响的完整上下文批次失效；修复并发批次顺序和重复读取续期导致的重复下游调用。旧 v1 缓存和已发布结果保留，缺少原始身份映射的旧批次不盲目迁移。
- `8b2dba65`：官方 DeepSeek Flash 后台结构化请求启用 JSON 模式；无效 JSON 进入既有一次修复，不循环付费重试。提示明确全部 Timeline 字段限制，未放宽验证。兼容官方将 usage 放在空的末尾 stop choice 中（包括 role:null）的协议，仍要求一致身份、合法整数用量和完整流结束。未知用量的历史预留不清除。
- `e55476cd`：验收包可显式启用有界、按 Space 隔离的本机诊断，仅导出错误码、数值计数和安全校验路径；没有消息正文、模型输出或凭据。预算标题显示实际配置上限。默认产品构建不开启诊断。

### 验证边界

- 当前代码全量 Flutter 测试 **1150 通过 / 5 跳过 / 0 失败**；最后仅风格等价修正后，analyze 无问题，相关定向 **65/65** 通过。
- 已分别复现并关闭：恢复队列反复读取前缀、并发完成顺序改变缓存键、保留期限续期丢失缓存、观察在授权期间过期、旧请求排队或写入期间跨越重新授权、官方 DeepSeek 末帧用量未被接受。HTTP、存储、模型用量及故障注入回归属于模拟边界验证。
- build 11 iPhone Release 完整编译、同身份原地安装和设备版本回读通过；简洁与完整双向切换、旧思考/工具恢复、作品入口和新飞书卡片/spinner 已实际观察。已有消息缓存保留，启动增量同步时计数没有清零。
- build 11 Android Debug 已通过签名证书与原安装比较，并保留数据原地安装。独立 Space 的旧对话仍可见；模型服务、前脑预置厂商、自动填入 DeepSeek 模型与绿色密钥状态已观察，语音验收草稿已取消。
- 飞书已有应用绑定与用户授权已在 iPhone 完成；实际 DeepSeek 调用曾产生可打开的部分近况，后续校验失败和保守预算暂停均真实发生，不能写成 Profile/Timeline 整体通过。
- build 12 正在准备验证 JSON/末帧兼容修复及安全诊断；两端最终生成、重开复用、Android 俄罗斯方块和最终合入结果待补。原签名能力仍不覆盖 Push/App Groups；本轮未进行真实语音通话。

### 保守边界

- 观察清单可增量复用，但新增授权聊天等权限范围变化仍使相关缓存失效；不会跨授权范围复用。
- 基于创建时间的增量 API 不保证主动发现时间窗口之外的远端旧消息编辑/删除。接收到变更时会使相关观察失效。
- 尚未照搬 PC 的完整 mention/回复链元数据或常驻定时同步；当前个人事实引用校验保持保守，不通过放宽本人证据要求补召回。


## 2026-10-30 主线程卡顿、过程间距与 Android 复核

以下为上节的后续证据，不能将历史中「待验证」理解为已全部通过。

- `a6789625`：大缓存解码、写入快照编码、授权证据投影与指纹计算移到后台 isolate；单次统计同时生成状态与对话计数。飞书页面复用统计，折叠时不构建聊天详情；后台进度不再反复重建整个聊天或资料投影。授权、数据版本、到期与写入失败回滚边界保留。
- 合成的 16,800 条文本、155 个聊天、约 14.2 MB 缓存中，原同步路径造成约 1.65–1.71 秒主 isolate 心跳延迟；最终独立测试最大延迟 55 ms。后台总处理耗时仍可能更长，此结果证明主 isolate 阻塞下降，不是 iPhone FPS 或总吞吐提升的证明。
- `8c9b505c`：思考与工具条目的上下间距统一，移除纯思考内容内部空占位；用户消息、最终回复与作品保留各自边界。窄屏和双倍字号回归覆盖。
- Android 原安装证书与各升级包一致，均原地安装，未卸载或清空数据。build 12 与升级前 6 个原业务 JSON 文件逐字节一致；此后新增的验收对话和作品是已授权任务产生的变化。
- Android 独立运行下，真实 DeepSeek Flash 完成基础俄罗斯方块：只有一张作品卡片，思考和合并工具条目可见，没有源码长度错误。实际打开游戏并执行触控移动、旋转、落下、暂停/恢复，观察到方块落地与分数变化。实际工具结果同时记录浏览器检查完成、无页面错误，以及移动、落下、消行、重置和键盘检查通过；旋转自动检查使用对称方块，只证明操作可执行，未证明非对称矩阵改变。
- Android「模型服务」子入口、中央服务密钥的已配置标识、级联前脑预置厂商与语音密钥状态已目视确认；验收草稿取消，没有修改现有语音设置或进行真实通话。
- Android 简洁模式切换、冷启动保持，以及恢复完整模式后旧思考/工具/作品重新出现已实际确认，最终恢复完整模式。iPhone build 11 的双向显示验证仍保留，之后按用户要求停止操作 iPhone。
- 两端已分别通过飞书官方网页绑定用户选定的已有应用，并完成相同账号授权。Android 使用一个真实聊天的近期范围同步，保存 72 条消息；升级和重开后计数未清零。真实整理已发布非空个人信息，来源入口可见；后续失败重试的安全诊断确认 72 条观察全部复用。

### Android 现场发现的两处生成问题

1. Timeline 主题归并开启 JSON 模式但提示词漏掉 JSON 字样；与官方协议要求不符，失败阶段也停在归并。增加所有 Timeline 阶段的请求契约回归，先失败后补齐；修复后真实调用通过归并并到达正文生成。
2. Timeline 正文连续输出内部 speaker/chat 代号，被既有校验拒绝。复用个人信息撰写已有的代号与本地地址修复说明，并验证修复请求包含具体解释。后续现场又遇到「事实数量过多 → 修复后内部代号」的不同错误链，正文生成/审查阶段改为最多两次纠正；重复原因、纠正后仍无效 JSON 或达到上限立即停止。选题/归并阶段仍只纠正一次，原主题成员约束保持。不放宽校验，不改写原文引用，不无条件删除错误卡片来制造成功。代码分别提交为 `4c21e6ec` 和 `86179a9f`。

未知供应商错误码现在保留已知 HTTP 状态；本机验收诊断增加白名单阶段名，不保存供应商正文、异常文本、堆栈、消息或密钥。

最终代码全量测试 **1164 通过 / 5 跳过 / 0 失败**，analyze 无问题；相关定向 **84/84** 通过，包含不同错误链成功、第三个错误硬停止、重复原因停止和无效 JSON 有界纠正。Android Debug **1.0.0 (17)** 编译、同证书检查、保留数据安装与安装版本回读完成，私有 SHA-256 清单已保存。独立源码复核未发现 P1/P2。

当前验收边界：build 17 的最终 Timeline 修复尚待现场结果，不能标为完整生成通过。Mac 镜像曾连续报截图创建失败，当时内盘空间不足；重建镜像会话后恢复，未删除用户文件。随后 Android 自动锁屏，已请用户解锁并打开 Nova，等待最终整理验收。iPhone 保持用户使用状态，未安装主线程优化及最终 Timeline 修复，需后续配合验证。真实语音、Relay Client 联动、Push/App Groups 与新一轮 PC 整体验收不在本次新增证据内。

费用沿用用户批准的两端合计 ¥15 上限：iPhone 整理上限 ¥12，Android 整理上限 ¥1.50，已结束的 Android 游戏任务保留 ¥1.50。游戏三轮的输出/历史 UTF-8 字节上界及每轮额外提示与工具余量，按无折扣峰值价格核算的保守上界小于该预留；不是精确账单。旧未知用量预留全部保留，未清空账本或释放旧票据。私有对话、应用身份、凭据、备份、日志、截图和产物均未加入 Git。


## 2026-10-30 PC 质量对比与 Android build 18

用户反馈手机整理质量明显低于 PC，并指出 Timeline 仍未生成。对照实际 PC 调用链，差异与迁移顺序记录在 docs/reviews/mobile-pc-feishu-parity-2026-10-30.md。不是同样本/同模型 A/B，因此不把全部差距归因于模型或平台。

- build 17 再次真实重试仍停于正文，重复内部代号导致完成批次 0；旧观察全部复用，失败证据保留。
- 参考 PC 迁移逐卡严格复验与失败批次隔离，代码提交 977df17a。只在原有有界纠正停止后保留仍通过完整格式、引文、时间和主题校验的卡片，合格草稿仍经过审查；部分阶段不当作完整 checkpoint，坏缓存继续失败。全无可用卡、审查删光全部保留项仍失败；授权/网络/存储/预算错误不被吞掉。部分结果保留 pending，固定状态 profile_timeline_partial 停止自动付费循环并说明已有结果保留。
- 独立源码复核未发现此隔离策略的 P1/P2。全量 **1171 通过 / 5 跳过 / 0 失败**；测试风格等价修正后 analyze 干净，最终相关定向 **39/39**。覆盖混合好坏卡、全坏卡、跨批次隔离、审查清空、损坏缓存不静默重生成、部分状态重开不自动付费。
- Android Debug **1.0.0 (18)** 已完整编译、核对相同证书、保留数据安装、回读版本并实际启动。没有清空聊天、任务、来源或密钥，没有操作 iPhone。
- build 18 实际生成并展示近况卡，原文入口可打开；安全诊断为 ready/completed，完成 1 批、pending 0、drop 0，72 条观察全部复用。本轮没有实际触发逐卡丢弃分支；该分支的证据是上述回归测试。重开飞书页面及无变化重复同步后仍保留 72 条消息，保守预算占用未增加。
- **内容质量验收失败，尚不合入**：原文核对发现一张卡将非 self 发送者的发言写成“本人提出/澄清”。连续 quote 和 schema 合格不能证明实际行动者正确。手机 Timeline 混用了画像本人语气，且缺少 PC 作者/回复关系和独立近期原文链路，作为下一批最优先迁移项；不因本轮终于有卡就宣称达到 PC 质量。
- 当前 Android 整理保守预算占用为 ¥1.142624（包含未知用量预留，不是账单）；本次两端上限仍为用户批准的 ¥15，没有清除旧预留或扩大上限。未进行 PC/手机同输入模型 A/B。
- 对比文档另列长期画像相关性过滤、近两周时间语义、稳定旧卡身份与增量修订、丰富卡片结构和可选独立审查模型。尚未迁移的内容不标为完成。原始聊天、身份与私有证据没有加入 Git。

## 2026-10-30 下午 移动端主体归属迁移与 Android build 19

当前结论以 docs/handoffs/mobile-feishu-quality-next.md 顶部“下午”小节为准；实现契约见 docs/handoffs/mobile-feishu-quality-contract.md。

- 按契约 T1–T4 迁移 PC 的作者元数据、Timeline 独立主体规则与近期原文输入、时间校验、画像 relevance 选材和 Timeline 增量身份；四轮 Codex 对抗审查共 10 项发现，9 项已修复，1 项（被编辑原消息的卡片对账）按用户产品决定记为已接受限制。代码 HEAD c910cf74，未合入、未 push。
- 换到新 Mac：构建输出与缓存放内置盘，按 canonical worktree 路径与会话 ID 分目录（`<build-dir>`）；外置盘不再使用，功能 worktree 残留的 core.worktree 配置已删除（备份在该 `<build-dir>/logs/`）。
- 全量 1257 通过 / 5 跳过 / 6 个环境类失败（2 个截图 golden、4 个计时用例，基线同样出现）。
- Android 1.0.0 (19) 相同证书原地安装，业务数据哈希一致。2 张卡逐条核对原文，主体归属全部正确，build 18 的错误归属卡不再显示；无变化重启账本零增长。仍有一处漏引原文和画像过度概括两项质量问题；设备上元数据补读未观察到；同模型 A/B 与 iPhone 未做。

## 2026-10-30 傍晚 元数据补读修复与 Android build 21

- build 19 首次同步触发元数据补读后，全部卡片与画像变为“原始来源已不可用”并在下一轮出现重复卡；原因是证据指纹覆盖全部存储字段。b3283e86 改为只覆盖内容身份，a7d84b0d 保留旧 schema-1 历史并只把可验证的原文转为新指纹。
- 全量 1263 通过 / 5 跳过 / 2 个新 Mac 截图 golden 失败。Android 1.0.0 (21) 原地安装：2 张卡无重复、原文可打开、直接@你标签与 PC 存储一致、再次同步稳定、账本不变（¥1.502848 保守占用）。
- 被编辑原消息相关的边界按用户产品原则不支持；详见 docs/handoffs/mobile-feishu-quality-next.md 顶部“傍晚”小节。未合入、未 push。
