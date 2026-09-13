# 01 多入口与主窗口

> 轨道 B。目标：用户在桌面可以打字、长按说话得到可编辑草稿、或切到全双工语音，三种入口共享
> 同一会话、任务、记忆与授权；主窗口提供 动态 / 任务 / 记忆 三个视图，可以收起为现有语音悬浮窗
> 继续交互。语音不再是唯一入口，但全双工语音的端点检测、打断等实时语义保持不变。

状态：待评审。对应里程碑 M5-B、M6-B（见 [STATUS](STATUS.zh-CN.md)）。

## 1. 现有基础

- **协议**：`docs/protocols/client-v1.md` "级联可编辑输入"一节。级联主机在 `client.ready.capabilities`
  中声明 `text_input`、`dictation`；`input.text`（≤4000 UTF-16 单元）、`input.dictation`
  （`id` + `start | finish | cancel`，草稿缓冲 16 kHz PCM16 ≤60 秒，finish 调用级联 ASR，30 秒超时）、
  `input.audio`（结束草稿模式，恢复连续语音）；识别结果 `input.transcription`。
  **草稿不是用户轮次，不触发 LLM 或工具；客户端必须显式发送编辑后的 `input.text`。**
- **runtime**：`runtime/src/desktop.ts` 定义上述 payload 的 zod schema；`runtime/src/desktop-session.ts`
  持有草稿状态机；`runtime/src/client-protocol.ts` 仅在 `pipeline_mode = cascaded` 时声明能力；
  `runtime/src/realtime/service.ts` 要求 provider 具备 `transcribeDraft` 能力。
- **管线**：`runtime/src/cascaded-realtime-assembly.ts` 按 `pipeline_mode` 选 `integrated`
  （单一实时语音模型，`runtime/src/realtime/qwen.ts`）或 `cascaded`（端点检测 → ASR → LLM → TTS，
  `runtime/src/realtime/cascaded/`）。
- **客户端接线现状**：桌面 renderer（`clients/desktop/src/renderer/*.mjs`）未接
  `input.text` / `input.dictation`；iOS 的 `Client.swift` 已实现文字发送、长按 dictation 状态机
  与麦克风权限处理（**代码已实现**），但**真机验收未完成**，spec 09 仍标 planning。
- **桌面已有面板**：`task-banner.mjs`（解析 `EXECUTOR_TASKS`：`{revision, active_project,
  tasks[{work_id, executor, project, title, phase, summary, ts}]}`，phase
  `started | working | completed | cancelled | failed | refused | unknown`）、`memory-board.mjs`、
  `knowledge-panel.mjs`、`capabilities-editor.mjs`、进度气泡。
- **状态所有权**：会话、任务、授权、交付的事实来源是主机；桌面已按此约定消费。

### 1.1 Qwen 实时协议文字输入调研（2026-09-10）

问题：integrated 管线能否在同一会话里同时接文字与音频？

- Nova 当前 integrated 默认模型是 `qwen-audio-3.0-realtime-plus`（`runtime/src/config.ts`、
  `runtime/src/environment-contract.ts`）。`runtime/src/realtime/qwen.ts` 已经在同一会话中
  交替发送 `input_audio_buffer.append` 与 `conversation.item.create`（`input_text` 内容），
  `turn_detection` 在连接时设一次且不再切换。但**现有所有 `input_text` 都是主机注入**
  （工具结果、工作区上下文、进度事实，并明确标注"不是用户说的话"），没有真实用户文字轮次路径。
- Qwen-Audio-Realtime 官方文档（[用户指南](https://help.aliyun.com/en/model-studio/qwen-audio-realtime-user-guides)）
  记载 `conversation.item.create` 支持 `message`（role `system | user | assistant`，含 `input_text`）、
  `function_call`、`function_call_output` 三种 item；未记载禁止文字与音频混用。限制是
  `turn_detection` 只能在发送首段音频前设置，切换交互模式需重连。
- 参考项目 `thirdparty/qwen-audio-agent` 对同一模型系已实现用户文字轮次
  （`server/src/voice/realtime-provider.mjs` 的 `sendUserText`，与音频同会话），并把
  "文字轮次取消进行中的语音轮次"作为其自身 UX 策略。
- Qwen-Omni-Realtime 系（`qwen-omni-turbo-realtime`、`qwen3.5-omni-*-realtime`）的官方
  [客户端事件页](https://www.alibabacloud.com/help/en/model-studio/client-events)记载
  `conversation.item.create` **仅支持 `function_call_output`**，[概览页](https://www.alibabacloud.com/help/en/model-studio/realtime)
  记载音频输入为必需。参考项目文档称 Omni 系也接受文字输入，与官方页面冲突，本次未能核实。

结论：对 Nova 实际使用的 Audio-Realtime 系，**协议层支持带 `input_text` 的 user message**，
置灰不是 provider 协议限制。但以下三件事未经验证，不能概括为"只补能力声明"：
（a）真实用户文字轮次是否稳定触发响应并进入对话历史；（b）文字轮次到达时进行中的语音轮次如何取消，
`smart_turn` 下服务端自动响应与主机 `response.create` 如何关联；（c）主机交付记账在文字轮次下的语义。
若未来切到 Omni 系，文字入口按官方文档不可用。是否为 integrated 补文字入口列为待评审（§4），
不影响 D2"桌面默认 cascaded"。

## 2. 本卷新增

### 2.1 管线默认值

- 桌面默认 `pipeline_mode = cascaded`。文字、草稿、全双工语音共用同一个 LLM 会话。
- integrated 保留为设置中的"纯语音低延迟模式"。选中时：输入框置灰，提示"当前模式只支持语音；
  切换到默认模式可打字"；`client.ready.capabilities` 如实不声明 `text_input` / `dictation`。
- 纯文字使用不初始化麦克风；麦克风在用户首次切到草稿或全双工时申请权限。
- 现有用户若已配置 integrated，升级后不静默改动其设置；首次启动主窗口时提示一次可切换。

### 2.2 输入框三态

同一个控件，三种状态，状态由用户显式切换，主机以能力声明约束可用状态：

| 状态 | 用户动作 | wire 事件 | 何时成为用户轮次 |
|---|---|---|---|
| 打字 | 输入、回车或点发送 | `input.text` | 发送即轮次 |
| 草稿 | 长按录音键，松手 | `input.dictation start` → 二进制 PCM → `finish`；收到 `input.transcription` 后填入输入框可编辑 | 用户点发送才发 `input.text`；识别失败保留已有文字并显示 `recognition_failed` |
| 全双工 | 点击"持续对话"切换 | `input.audio` 恢复连续语音；输入框位置显示实时转写（只读） | 由级联端点检测决定，沿用现有语义 |

- 全双工状态下再点输入框，主机进入草稿或打字模式前先停止连续采音；三态互斥。
- 草稿缓冲、超时、取消、断线语义以 `client-v1.md` 为准，本卷不改。
- 输入框显示的实时转写来自主机；renderer 不自行跑 ASR。

### 2.3 主窗口信息架构

- **左侧**：常驻对话列。显示当前会话的用户输入、Nova 回复、任务卡（"任务已开始：…"）、
  以及来自 feed 的"接着聊"锚点。输入框固定在底部。
- **右侧**：三个 tab。
  - **动态**：渲染 02 卷的 `feed_item` 列表与空状态；用户动作回传（`open / act / snooze / dismiss /
    expand_evidence`）。名称"动态"为工作名称。
  - **任务**：复用 `task-banner.mjs` 的 `EXECUTOR_TASKS` 数据，展开为列表 + 详情（进度、等待用户的决定、
    产物）。任务真相仍以主机为准。
  - **记忆**：渲染 03 卷的 `memory_entry` 列表与可选概览；纠正 / 忘记 / 查看来源回传。
- **设置**：连接与权限（含 04 卷的来源管理）、管线模式、通知阈值；现有 capabilities-editor、
  knowledge-panel、memory-board（诊断）搬入设置或开发者面板。
- 从动态、任务、记忆的条目都可以"接着聊"，把引用带入对话列。

布局分区（左对话 / 右三 tab）已确认；具体视觉设计、尺寸、是否允许拖拽分栏待评审。
不照搬参考产品的名称与页面外观。

### 2.4 收起态：悬浮窗

- 主窗口收起为现有 orb。会话、后台任务、feed 状态全部不变；重新展开从主机恢复。
- orb 上的新事项提示：出现新的 `feed_item` 时显示角标；达到通知阈值的事项以现有进度气泡样式
  显示一条摘要；默认不出声。语音交付仍走 Floor 与 Surrogate 选择路径（02 卷 §2.5）。
- 麦克风状态独立于窗口状态。收起不等于允许持续采音；用户在收起前处于打字或草稿态，收起后
  麦克风保持关闭，orb 显示为静音。
- 桌面静音时主动内容仍通过 feed 与文字呈现，不因静音丢失。
- 进程状态在 orb 与主窗口都可见："运行中 / 后台任务 N 个 / 已断开"。主窗口关闭不等于进程退出，
  退出走显式菜单。

### 2.5 共享主机状态

- renderer 不维护第二份权威任务列表、feed 列表或记忆列表；全部从主机订阅并按 `revision` 更新。
- 主窗口与 orb 是同一 renderer 进程的两个视图（或同一主进程的两个窗口，落地时定），
  订阅同一份状态；不存在两份连接。
- iOS 通过 `/client/v1` 消费同样的 `feed_item` / `memory_entry` / `EXECUTOR_TASKS`，
  但本系列不承诺它们在 M6 前实现新视图。

## 3. 不做

- 不新起客户端。
- 不给 integrated 管线加文字入口（列为待评审，见 §5）。
- 不改草稿缓冲、超时等协议参数。
- 不在 renderer 跑 ASR 或任何模型。
- 不做 Windows / Linux 特定布局；跨平台验收沿用 v0.2.0 台账。

## 4. 待评审

| 项 | 选项 | 影响 |
|---|---|---|
| integrated 文字入口 | 不做 / M6 后补（先做 live 验证 §1.1 的 a、b、c，再改主机能力声明、`qwen.ts` 用户文字 item 与取消语义） | 做则纯语音模式也能打字；验证不通过则维持置灰 |
| 主窗口与 orb 的窗口形态 | 同一 BrowserWindow 变形 / 两个 BrowserWindow 共享主进程状态 | 影响动画与 macOS 行为；不影响契约 |
| 视觉布局 | 固定分栏 / 可拖拽 / 右侧可整体折叠 | 只影响 UI |
| 首页名称 | "动态" / 其他 | 只影响文案 |
| 现有 integrated 用户的迁移提示 | 一次性提示 / 不提示 | 影响升级体验 |

## 5. 验收场景

编号沿用讨论稿 §9。

- **1 直接使用**：全新安装，不自我介绍、不连接任何资料，打开主窗口打字交办一件事，任务出现在任务 tab；
  全程不申请麦克风权限。
- **2 切换入口**：文字提交任务后收起窗口；用语音问"那个任务怎么样了"，回答引用同一 `work_id`，
  任务 tab 不新增任务。
- **3 语音草稿**：长按录音、松手，识别文字出现在输入框；修改后发送才生成用户轮次；识别失败时
  输入框原有文字保留并显示失败提示；期间任务 tab 无新任务。
- **11 静音与后台**：静音后后台任务继续；新 `feed_item` 出现在 orb 角标；主窗口关闭后 orb 显示
  "运行中"；退出进程后 orb 消失，重开主窗口能恢复上次 feed 与任务状态。
- **三态互斥**：全双工中点击输入框，连续采音停止，草稿或打字可用；再切回全双工，`input.audio`
  发送且转写恢复。
- **管线切换**：设置切到 integrated，输入框置灰并显示原因，能力声明中无 `text_input`；切回 cascaded 恢复。
