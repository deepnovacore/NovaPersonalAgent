# v0.3.0 进度说明（给同事 review 用）

> 日期：2026-09-10 · 状态：**全部里程碑未开始**，本页只有规划。
> 这份文档用大白话讲"我们要做什么、分几步、每步做完算什么、想请你们拍板什么"。
> 细节以各卷 spec 为准：[00 总览](00-overview.md)。

## 一、这个版本在做什么

v0.2.0 让 Nova 做到"开口就能让 Codex 干活"。v0.3.0 换一个定位：**Nova 是一个有持续记忆、
能发现潜在需求并跟进事情的通用个人 Agent**。用户可以打字、说话，也可以让它在后台工作。

本版明确交付 Kimi Code + pi agent、GUI/AutoGLM example，以及基于记忆的需求发现与主动关心。
前两项通过真实 agent2agent 闭环展示，具体边界见 [05 执行器规划](05-coding-and-gui-executors.md)。

三件事不变：交互（含主动交互与需求发现）、记忆、前后脑协作。变化的是：

- 语音从唯一入口变成入口之一。桌面默认可以打字，长按说话得到可编辑草稿，也能切到全双工。
- 加一个主窗口：左边聊天，右边看 **动态 / 任务 / 记忆**。收起来就是现在的悬浮窗，任务和会话不丢。
- Nova 会主动提建议，但每条都要有依据，没依据就闭嘴。
- 记忆对用户可见，能纠正、能忘记。
- 用户自己选哪些目录、哪个邮箱和日历给 Nova 读；读了多少看得见。

参考了 [today.ai](https://today.ai) 的"记忆可见、首页汇总"形态，但走开源项目的路：
本地运行、用户配置授权范围、来源可追溯、不宣称了解整台电脑。

## 二、里程碑总览

A/B 轨继续并行、各自小步：A 做需求发现，B 做窗口与入口。D 轨的 coding/GUI 接入可同步推进；C 轨的来源管理按 M7/M8 依赖推进，不阻塞执行器。

| 里程碑 | 一句话 | 依赖 | 退出条件 | 状态 |
|---|---|---|---|---|
| **M5-B** 文字入桌面 | 桌面默认 cascaded；输入框三态接线；主窗口骨架只含对话列和复用 task-banner 的任务 tab | 无 | 验收场景 1、2、3 通过；全新安装不申请麦克风也能打字交办任务 | ⬜ 未开始 |
| **M5-A** proposal 闭环 | Surrogate 输出可空 proposal；主机校验、入池、同日去重；低频检查事件；固定案例集 | 无（在现有悬浮窗和 iOS 输入框上验证） | 场景 4、5、6、7 通过；案例集 ≥10 应建议 + ≥10 应沉默全跑 | ⬜ 未开始 |
| **契约钉住** | `feed_item`、`memory_entry` 的 zod schema 与 fixtures；personal-memory 端口扩展（`list` / `get` / `correct` / `forgetEntry` / `capabilities`）；持久化交付与忽略台账 | 02、03 卷评审通过 | fixtures 进 CI；至少一个后端实现端口扩展 | ⬜ 未开始 |
| **M6-B** 动态页 | 主窗口消费 feed_item，用户动作回传；收起态角标与气泡；重开可恢复 | M5-B、契约 | 场景 11 通过；feed 空状态真实 | ⬜ 未开始 |
| **M6-A** 记忆页 | memory_entry 投影；纠正与忘记回写并传播；概览段落带覆盖声明 | M5-A、契约 | 03 卷五个场景通过 | ⬜ 未开始 |
| **M7** 本地目录来源 | 用户选目录；元数据概览后按预算读正文；增量与恢复核对；来源变化撤回 feed_item | M6-A（记忆传播） | 04 卷"目录覆盖诚实""排除生效"通过 | ⬜ 未开始 |
| **M8** 一个邮件 / 日历 provider | 增量同步、cursor 失效恢复、删除传播、改期冲突完整场景 | M7 | 场景 8、9、10 通过 | ⬜ 未开始 |
| **M9-C** 多 coding 后端 | Kimi Code 与 pi agent 分别适配既有 coding 调度、审批、进度、取消 | v0.2 执行器/审批契约；不依赖 M7/M8 | 每个后端独立通过工作闭环及拒绝/取消/失败场景，支持矩阵明确 | ⬜ 未开始 |
| **M9-G** GUI 执行器 | 以 AutoGLM 为首个 example，绑定设备与动作授权 | v0.2 执行器/审批契约；不依赖 M9-C、M7/M8 | 真机执行、拒绝、中途取消和状态不明场景通过 | ⬜ 未开始 |
| **M9-Demo** agent2agent | Nova 委派 coding/GUI 专长 agent 的复现说明与真实演示 | M9-C、M9-G | 版本/平台/权限/产物/限制完整，不把协作演示称为未经验证的 A2A 协议兼容 | ⬜ 未开始 |

不写日期。v0.2.0 的收尾项（真人语音、Windows 安装包、唤醒词验收）留在
[v0.2.0 STATUS](../v0.2.0/STATUS.zh-CN.md) 与 [RELEASE-GATE](../v0.2.0/RELEASE-GATE.md)。

## 三、已经定下来的事

2026-09-10 脑暴确认（详见 [00 卷"已定决策"](00-overview.md#已定决策2026-09-10-脑暴)）：

1. 两条轨道并行，先钉契约。
2. 桌面默认 cascaded；integrated 保留为纯语音低延迟模式。调研发现 Nova 用的 Qwen-Audio-Realtime
   系官方文档列出了带 `input_text` 的 user message，所以置灰不是协议层限制；但完整文字轮次、取消和
   交付语义都没验过，要不要补、怎么验，另议。
3. 记忆页以结构化条目为主，概览可选且必须写明"基于多少条、来源有哪些"。
4. 主窗口从现有 Electron 桌面长出，不新起 App；左对话、右三 tab。
5. 同一个输入框三态：打字 / 长按草稿 / 全双工。
6. 两个契约对象 `feed_item`、`memory_entry`，主机拥有，UI 不存权威副本。
7. 新开 v0.3.0 系列，里程碑从 M5 续编号。

## 四、现在的代码离目标有多远

| 子系统 | 已有 | 缺 |
|---|---|---|
| 文字输入 | runtime 有 `input.text` / `input.dictation`，协议已写进 client-v1；iOS Swift 已实现文字与 dictation 接线 | 桌面和 WebUI 都没接线；iOS 真机验收未完成 |
| 主动机制 | Suggestion Pool、Surrogate 选择、Floor 仲裁 | Surrogate 不会提新建议；没有用于需求发现的低频检查；没有 feed；没有持久化的交付 / 忽略台账 |
| 记忆 | personal-memory 端口（recall / remember / 按来源 forget）、workspace graph、开发者 memory-board | 端口没有逐条 ID、版本、列表、按条目纠正 / 忘记；没有用户视角的记忆条目和纠正 UI |
| 来源 | 知识库有界导入与检索 | 没有持续同步、没有邮件 / 日历、没有来源管理 UI |
| 执行生态 | Codex 执行器、能力注册表、外部 MCP | Kimi Code、pi agent 与 GUI/AutoGLM 接入待实现；Home Assistant 为后续候选 |
| UI | Electron 悬浮窗、任务横幅、进度气泡、各设置面板 | 主窗口、动态页、记忆页 |

## 五、不做什么

全盘采集、屏幕录制、独立需求模型、习惯预测、workflow 平台、多机容灾、关机后持续运行的承诺、
一次建插件市场、组织专属能力进公共分支。详见 [00 卷 Non-goals](00-overview.md#non-goals-v030)。

## 六、想请大家拍板 / 重点 review 的点

1. **首页名称与主窗口布局**：工作名"动态"；左对话右三 tab 已定，视觉细节没定。
2. **第一个邮件 / 日历 provider**：Google / Microsoft / IMAP + CalDAV。影响 OAuth 审核与目标用户。
3. **是否明确承诺"本地主机运行"为首版边界**：即电脑休眠、离线时不保证持续发现。
4. **首版写入范围**：只读 / Nova 内草稿 / 有授权的发送。
5. **主动提示的默认节奏**：低频检查间隔（15 / 30 / 60 分钟）与通知阈值。
6. **要不要给 integrated 补文字入口**：协议可行，但要处理文字轮次与进行中语音轮次的冲突。
7. **02 卷的去重策略**是否够用：同用户、同作用域、同稳定事项键、同日，基于持久化台账，不做语义去重。
8. **执行器具体接入**：固定 Kimi Code / pi agent 的版本和接口；AutoGLM 首个设备平台与应用场景；用能力矩阵暴露审批、恢复、steer 等不支持项。
9. **03 卷的 personal-memory 端口扩展**：VoiceMem 后端能否提供逐条稳定 ID 与版本；不能则 M6-A 的纠正只能降级。

## 七、相关文件

- 讨论稿：[docs/design-notes/2026-09-10-nova-personal-agent-product-architecture.zh-CN.md](../../design-notes/2026-09-10-nova-personal-agent-product-architecture.zh-CN.md)
- 协议：[docs/protocols/client-v1.md](../../protocols/client-v1.md)
- 架构不变量：[docs/archs/](../../archs/00-overview.md)、[docs/glossary.md](../../glossary.md)
- v0.2.0 系列：[docs/specs/v0.2.0/00-overview.md](../v0.2.0/00-overview.md)
