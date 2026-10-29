# v1 UI review polish 分支评审

## 2026-10-28 最终集成结果

**原 UI-1 至 UI-5 及两轮残留均已关闭，已本地合入 `v1.0.0dev`，当前 HEAD 为 `ea0fd201`，未推送。** 下文的“部分修复”是 `78d90b63` 的历史复核结论，不代表最终集成版本仍有该缺陷。

UI-2 在 `069daa6c` 中完成完整 provider reasoning 与有限 UI 副本分离，并为普通 stop 回复保存协议字段；对应普通回复后续问、70,000 字符思考后工具续轮均纳入本轮全量 runtime 验证。

UI-4 的 `069daa6c` 已保护旧图与旧 Store 路径，但复核发现 SharedPreferences 先更新缓存再持久化，失败时缓存仍可能指向被删的新图。用户随后明确授权补最小修复。最终另加 `ea0fd201`：恢复旧路径后也恢复偏好缓存，只有回滚确认成功才删除新图；回滚未确认时保留新旧文件，reset 失败也恢复缓存。新增测试模拟缓存先改再返回 false，覆盖回滚成功/失败、同进程重新 load 和 reset，修复前 3 个失败、修复后头像定向 28/28 通过。

集成记录：Core 合并提交 `884d8947`，UI 合并提交 `6cbe1190`，额外头像修复 `ea0fd201`。唯一源码冲突位于 `workbench-runtime.ts`，两侧字幕撤回及思考记录逻辑均保留，独立复核无新增阻断。原 UI worktree 仍位于 `069daa6c`，额外补丁在目标分支的独立提交中，未反向改写来源分支。

本轮实跑组合验证：`npm run check` 通过；runtime 4721 项（4705 通过、11 跳过、5 TODO、0 失败）；desktop 1660 项（1647 通过、13 跳过、0 失败）；Flutter 1007 通过、4 跳过，analyze 无问题；CLI 34/34、server-cli 4/4 通过。

首轮 Node 测试因仓库内临时目录继承 ESM 设置和 Unix socket 路径过长失败；已保留日志并改用仓库外短路径，完整重跑通过。日志及验证记录位于 `/Volumes/sqxh-junjie/nova-builds/review-merge-ec386f7dc50a-01a17d93/`。

原两个 worktree 和分支保留。主工作区原有文件在合并前后通过字节校验，仅这两份本地 review 随后更新；其他未提交改动未纳入测试。真实 DeepSeek 请求、移动端真机/存储故障、Electron 读屏、桌面打包及发布仍未执行。报告保持本地未跟踪状态，没有加入产品提交。

---

## 2026-10-28 修复复核（最新结论）

复核范围：`0d88afd8..78d90b63`；已确认分支为 `feat/v1-ui-review-polish`，HEAD 为 `78d90b63f497bcc3d6ca188d62c02304415ff561`，worktree 干净。

**结论：UI-1、UI-3、UI-5 可在源码复核层面关闭；UI-2、UI-4 部分修复，仍有下列具体缺陷。建议补齐后再合入。**

| 原项 | 当前状态 | 复核依据 |
| --- | --- | --- |
| UI-1 | 关闭（静态） | `workspace-bar.mjs:52–56` 在 await 前捕获 owner，只写原 owner；`workspace-bar.test.mjs:81` 覆盖请求挂起时 A → B 切换。 |
| UI-2 | 部分修复 | 短思考的 tool-call assistant 已保存 reasoning_content；普通 stop 回复仍漏保存，长思考仍被 UI 上限截断，详见下文。 |
| UI-3 | 关闭（静态） | `workbench-store.ts:194` 返回 thoughts_first_id，`build-steps.mjs:148` 检查其变化并从零重载；新增测试保持首条 tool 不变，检查中部 thought 淘汰。 |
| UI-4 | 部分修复 | 版本化文件名解决缓存问题，新图写入失败不再截断旧图；偏好保存失败后仍会删除旧图，详见下文。 |
| UI-5 | 关闭（静态） | `workbench-tabs.mjs:25,38` 使用固定基础标签；测试补齐 getAttribute，检查重复 true 及恢复 false。 |

### UI-2 残留 · P2：provider 私有思考仍不完整，普通回复后的续问仍会丢字段

**位置：** [chat-completions-llm.ts:168](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/runtime/src/realtime/cascaded/chat-completions-llm.ts:168)、同文件 `170–175`、`208`、`214`。

**场景与问题：** 开启 DeepSeek 思考，在一次带 tools 的 Plan / Build 中收到普通最终回复（`finish_reason: stop`），再发送下一条用户消息。`208` 只把 assistant 的 content 写入历史，丢掉这条回复的 reasoning_content；下次请求仍带 tools，因此保留了不完整的 assistant 历史。即使第一轮工具续轮已修好，普通回复后的下一轮仍可能返回 400，触发当前的静默关闭思考重试。

还有同一协议缺陷的另一条路径：`reasoningText` 在 `reasoningDelta()` 内只追加 UI 裁剪后的 chunk，最多 65,536 个 codepoint，之后的内容直接返回不处理。超过上限再返回工具调用时，`214` 回传的是截断副本，并非修复说明中所称的“完整 provider 私有 reasoning_content”。

**协议核验：** 本轮重新读取了 [DeepSeek 官方 Thinking Mode / Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)：带 tools 的思考请求需要完整回传历史 reasoning_content，也包括没有工具调用的回复；否则会返回 400。这里的后果根据官方协议与实际请求体构造推导，未发真实请求。

**最小修复：** 把完整 provider reasoning 的收集与 UI 展示截断分开，在已有流总量限制内完整保存；DeepSeek 的 tool-call 与普通 stop assistant 都应按协议保留该字段。增加两类请求体断言：“思考普通回复 → 新用户续问”和“超过 UI 限制的思考 → 工具结果续轮”。

**现有测试为何未拦住：** `realtime-cascaded-llm-reasoning.test.ts:114–136` 只检查短思考的工具调用到工具结果这两次请求；没有第三次用户续问，mock 的最终回复也没有 reasoning，未覆盖上述两条路径。

### UI-4 残留 · P2：偏好写入失败时仍删除旧头像，重启后两张图都无法恢复显示

**位置：** [pet_avatar.dart:188](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/clients/flutter/lib/ui/pet_avatar.dart:188)、同文件 `191–197`、`234–241`；加载恢复在 `181–183`。

**场景与问题：** 已有头像 A 和持久化路径 A。替换 B 时图像文件写入成功，但 SharedPreferences.setString 返回 false 或抛异常。`_persist()` 忽略 false，并吞掉异常；调用方仍删除 A，返回 true。当前会话可显示 B，但磁盘偏好仍指向被删的 A。重启后 load 发现 A 缺失，移除偏好并显示默认头像，B 成为没有引用的文件。

**最小修复：** `_persist()` 明确返回成功或抛出失败，并检查 setString 的布尔结果；只有偏好确认保存成功后才删除 A。失败时保留/恢复原路径与原文件，清理新图并向用户报告失败。增加偏好返回 false / 抛异常，以及创建新 store 后重新 load 的测试。

**现有测试为何未拦住：** `pet_avatar_test.dart:138–154` 在创建目录阶段制造失败，证明未触碰旧图，但没有覆盖新图写完后偏好保存失败。版本化文件并不能单独保证“持久化路径切换成功后才清旧文件”。

验证记录：修复方报告 desktop、runtime、flutter 全量及 `npm run check` 通过。本轮独立检查源码、调用链和测试设计，没有重跑这些命令，也没有核验测试日志。报告中的源码关闭状态不等于本轮测试通过。

未检查：真实 DeepSeek 请求、Electron 读屏、移动端真机换图/存储故障、两个分支合并后的行为。只更新文档，没有修改源代码、提交、合并或推送。

---

## 2026-10-27 初审记录（保留历史）

初审结论：在 `0d88afd8` 上发现以下 5 项；当前状态以文首复核为准。下面的位置及推导针对初审快照。

## 范围与证据边界

- Worktree：`/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish`
- 分支：`feat/v1-ui-review-polish`
- 目标：`0d88afd84adecd392ac7302f3f0291ff3554502c`
- 比较基线 / merge-base：`6531ac71ff88fe0d047924b01d8710fdde3764c6`
- 范围：6 个提交、91 个文件；目标 worktree 评审前后均无未提交改动。
- 这批修改增加 Build 思考/工具步骤、桌面显示设置及导航反馈，调整移动端头像、任务和 Timeline 展示。
- 主评审复核 runtime/provider/store；`gpt-6-astra` 独立审查桌面；`gpt-6.1-sol` 独立审查 Flutter 和资源引用。按单用户桌面/移动端、异步请求期间允许切换会话、长 Build 多轮运行判断。
- 以下为静态调用链及本机 SDK / 官方协议核验，没有运行测试、构建、服务、真实模型调用或真机验收。没有修改目标代码，没有 commit、merge 或 push。

## 必须修复

### UI-1 · P2：新建工作区的异步结果会写入后来切换到的会话

**位置：** [workspace-bar.mjs:52](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/clients/desktop/src/renderer/workspace-bar.mjs:52)、`53`；关联同文件 `25`、`62`。

**功能与触发：** 在会话 A 中新建工作区，请求未返回时切换到会话 B，然后等待创建完成。

**问题与证据：** `submitCreate()` 在 await `workspaces.create` 之后才调用 `state()`，默认实现读取此时的 `c.selectedId`。结果会覆盖 B 的 workspace，而 A 没得到创建结果。旧实现先捕获 owner；同文件的文件夹选择路径也仍在异步操作前捕获 owner。`creatingBusy` 只禁用工作区控件，没有锁住会话切换。

**最小修复：** 发请求之前捕获该会话的 state/owner，只把结果写回 owner；UI 刷新再按当前会话处理。添加延迟返回期间 A → B 切换的用例。

**不修复的影响：** B 下一次 Build 可能进入用户原本为 A 创建的工作区，读写错误的项目；A 仍保留旧工作区。这是用户数据/项目归属错误，不只是下拉框显示不一致。

### UI-2 · P2：开启 DeepSeek 思考后丢弃工具续轮必需字段，随后被静默降级

**位置：** [chat-completions-llm.ts:193](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/runtime/src/realtime/cascaded/chat-completions-llm.ts:193)、`205`、`211`；关联同文件 `155–158`。

**功能与触发：** 选 DeepSeek、开启 `buildReasoning`，执行一次需要工具的 Plan / Build。模型返回思考与工具调用后，宿主提交工具结果继续请求。

**问题与证据：** 新代码把 `reasoning_content` 仅作为显示事件发出，assistant 历史和 pending 工具消息都没有保存它。DeepSeek 对携带 tools 的思考请求要求完整回传该字段，缺失会返回 400，见 [DeepSeek 官方 Thinking Mode / Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)。收到这个 400 后，现有通用回退会将其误认作不支持 thinking，设置 `#reasoningUnsupported`，关闭思考重试。

**最小修复：** 在 provider 私有消息/checkpoint 中按协议保存并回传完整 reasoning 字段，与供 UI 展示的截断副本分离；不要把它合并进用户可见正文或 TTS。若暂不能支持，应明确限制该 provider 的思考开关。增加带工具的两次连续请求测试，检查第二次请求体而不仅是第一轮显示事件。

**不修复的影响：** 开关已启用且首轮看得到思考，但工具续轮产生一次错误请求后，整个 session 静默退回非思考模式。这里不能直接认定整轮必定失败，因为 disabled 回退可能成功；可以确定的是所选功能没有按设定持续工作。

### UI-3 · P2：第二次思考淘汰发生在列表中部，步骤增量分页继续使用失效 offset

**位置：** [build-steps.mjs:137](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/clients/desktop/src/renderer/build-steps.mjs:137)、`147–156`；[workbench-store.ts:180](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/runtime/src/personal-agent/workbench-store.ts:180)、`191`。

**功能与触发：** 同一 Build 持续多轮运行，保留的 thought 超过 64 条，工具 call 历史仍保留；长 thought 触发总字节上限时也会提前淘汰。

**问题与证据：** store 合并 thoughts 与 calls 后按时间排序，只淘汰 thoughts。首次淘汰第一条 thought 时，`first_id` 会变成第一条 tool，UI 会重载；下一次淘汰发生在这个永久保留的 tool 之后，`first_id` 不再变化。UI 从缓存长度或第一个未完成工具的旧 offset 开始，只覆盖后缀，因而不能发现中间删除。

**具体例子：** 已缓存 `[c1,t2,c2,...,t65,c65]`，所有工具完成，共 129 项。加入 t66 同时删掉 t2 后仍为 129 项，首项还是 c1。以 offset 129 拉取返回空页，UI 保留 t2 并漏掉 t66；之后加入 c66 只会补上 c66。`total < offset` 的防护也不会触发。

**最小修复：** 返回能反映 thought 淘汰的版本/标识，淘汰后从 0 重载；或者使用不随中间删除漂移的分页方案。测试应包含“保留第一条 tool、连续两次 thought 淘汰”，现有仅首项变化的场景不够。

**不修复的影响：** 长任务显示已经被淘汰的旧思考、漏掉新思考；若旧 offset 指向运行中工具，还可能保留过期工具状态，削弱工作步骤作为执行反馈的可信度。

### UI-4 · P2：替换自定义头像复用旧图像缓存，且失败写入会损坏旧头像

**位置：** [pet_avatar.dart:215](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/clients/flutter/lib/ui/pet_avatar.dart:215)、`218–220`、`298–304`。

**功能与触发：** 先选择照片 A 并显示，再选择照片 B。另一个失败场景是在已有头像时替换照片，写入新图过程中磁盘满。

**问题与证据：** 每次都覆写固定 `pet-avatar.png`，`Image.file` 的路径、scale 和解码尺寸未变；虽然 `_revision` 增加，但没有参与 Image provider 的身份或清缓存。Flutter `FileImage` 不监控文件内容变化，相等判断只比较路径和 scale，所以仍会复用照片 A。另因默认 `FileMode.write` 先截断旧文件，写入失败后 catch 只报错，原路径却可能已经指向损坏图像。

**最小修复：** 完整写入新版本文件，成功后才切换持久化路径并通知 UI，最后清理旧文件。一次修改可以同时解决 provider 缓存身份及覆盖失败丢失旧头像的问题；只给 Widget 加 key 不足以清除相同 provider 的图像缓存。

**不修复的影响：** 用户看到保存成功却仍显示旧头像；失败的替换可能连原头像也丢失。现有测试检查首次安装及路径，没有覆盖连续换图的像素结果和失败保留旧文件。

**协议依据：** 已只读核对本机 Flutter SDK `/Volumes/sqxh-junjie/DeveloperStorage/SDKs/flutter/packages/flutter/lib/src/painting/image_provider.dart` 的 FileImage 文件变更说明及相等实现，以及 Dart `File.writeAsBytes` 默认截断语义。没有运行截图或失败注入测试。

### UI-5 · P2：计划徽标反复向读屏标签追加状态，清除后仍声称有新计划

**位置：** [workbench-tabs.mjs:38](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/clients/desktop/src/renderer/workbench-tabs.mjs:38)；关联 [personal-view.mjs:200](/Users/fishwowater/sqxh/nova-audio-agent/.worktrees/v1-ui-review-polish/clients/desktop/src/renderer/personal-view.mjs:200)。

**功能与触发：** 出现新计划后连续收到界面更新，然后打开计划清除徽标；使用读屏查看任务 tab。

**问题与证据：** `pending()` 用当前 `aria-label` 作为 base，每次 true 都再追加“有新计划”；false 又把已经含状态的 base 原样写回。调用两次 true、一次 false 后，标签会成为“任务 · Agent 执行 · 有新计划 · 有新计划”，虽然可视徽标已清除。真实 DOM 有 `getAttribute`；测试的 Node mock 缺少该方法，走 `node.title` 回退，恰好掩盖了问题。

**最小修复：** 始终从初始化时的固定标签或 `node.title` 构造 aria-label。让测试 DOM 实现 getAttribute，覆盖重复 true 和 true → false。

**不修复的影响：** 读屏用户持续听到重复且错误的未读计划状态；重复更新还会不断增长该属性。

## 资源核验与未检查项

移动端评审核对了新增默认头像与已批准 iOS 原图的字节一致性，以及文档列出的六张当前 golden 的 SHA-256。文档仍将相关截图标为待 owner review，因此这些核验不能替代截图发布审批。

初审建议先修复 UI-1 至 UI-5；最新关闭状态及两项残留见文首。未将未证实的任务计数或 Timeline 候选列为缺陷。

未检查：完整测试、编译、实际 Electron DOM/读屏、移动端真机连续换图、真实 DeepSeek 请求、两个分支合并后的组合行为，以及完整公开历史/资产发布审计。本报告不构成发布或真机验收结论。
