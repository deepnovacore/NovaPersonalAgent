# 文字回复流式输出：运行时契约

日期：2026-10-26。范围：`runtime/`。桌面渲染端已就绪（见下文"渲染端约定"），不要改 `clients/desktop`。

## 已证实的根因

真实模型实测（`qwen3-vl-plus`，请求带 11 个工具）：上游在约 6 秒内返回 467 个增量，provider 却在流结束时才一次性吐出整段 `text_delta`，界面随即整段出现，增量全部丢失在 provider。

位置：`runtime/src/realtime/cascaded/chat-completions-llm.ts` 的 `chat()` 流循环。只要 `input.tools.length > 0`，文本只累加进局部变量 `text`，直到 `finish_reason === 'stop'` 才 `yield {kind:'text_delta', text}`；遇到 `finish_reason === 'tool_calls'` 则这段文本被静默丢弃。

这是有意为之：`adapter.ts` 对"先文字后工具调用"的混合回复抛 `MixedResponseFailure`（不可恢复的 `cascaded_mixed_text_tool`），所以 provider 必须保证带工具时文本和工具调用不会同时到达。

**因此不能简单地提前发 `text_delta`**，那会让现在正常的"先说一句再调工具"整轮失败，并且语音路径会在不确定是否是纯文本回复前就开始 TTS。

## 设计：只用于显示的预览事件

1. 在 `CascadedLlmEvent`（`realtime/cascaded/llm.ts`）新增 `{kind:'text_preview'; text:string}`，语义是"可能被撤回的、仅用于显示的增量"。**权威的 `text_delta` 行为一字不改**：带工具时仍然只在 `stop` 时发一次完整文本，遇到 `tool_calls` 仍然不发。
2. 预览是 opt-in：`CascadedLlmInput`（或 session 构造参数，选更小的改动）增加 `previewText?: boolean`，默认 `false`。`false` 时 provider 的行为和现在逐字节一致，不发任何新事件。
3. `chat-completions-llm.ts` 在 `previewText && input.tools.length > 0` 时，每收到非空 `content` 就 `yield {kind:'text_preview', text: content}`（保持原有的 `started`/`response_started` 顺序约束：预览必须在 `response_started` 之后）。`finish_reason === 'tool_calls'` 时不需要额外事件，由消费者根据后续 `tool_call` 撤回。
4. `realtime/cascaded/adapter.ts`：
   - 仅当 `this.#textOnly` 时处理 `text_preview`：对每个预览发 `response_transcript_delta`（沿用现有 `#emit` 路径，使 `captionFor` 的 `#captionAuthorized` 等门禁照常生效）。语音模式（非 `textOnly`）**忽略** `text_preview`，TTS 行为不变。
   - 记录已预览的文本。随后到达权威 `text_delta`（即 `stop`）时：如果它以已预览文本开头，只对**剩余部分**发 `response_transcript_delta`，不要重复追加；不一致则不再追加（以免 caption 错乱），最终的 `response_transcript_final` 仍按现状带完整文本。
   - 若预览之后收到 `tool_call`（而不是 `stop`），**不要**走 `MixedResponseFailure`：预览不算 `textSeen`。改为发一次 `response_transcript_final`，`text:''`，即撤回信号，然后按现有流程处理工具调用。
5. `personal-agent/workbench-runtime.ts`（Plan/Build，约 262 行附近）：请求时打开 `previewText`；对 `text_preview` 发和现在一样的累计 caption（`type:'caption',role:'assistant',text,full_text,turn_id,final:false`，沿用 4000 字符截断）。权威 `text_delta` 到来时用 `assistant` 覆盖 caption（内容应一致）。遇到 `tool_call` 时预览文本不进 `assistant`，caption 回到上一轮的权威文本；如果这一轮没有任何权威文本则发一次 `text:''` 的 `final:true` 撤回。
6. `conversation-runtime.ts` 里 `configuredTextLlm` 的调用方负责打开 `previewText`（仅文字路径；语音路径不开）。
7. 不改 Ark（`ark-llm.ts` 已逐段转发）、不改 `responses-model-gateway.ts`（它忽略未知 kind，保持）。

## 渲染端约定（已实现，勿改）

- `chat-pane.mjs` 把 `type:'caption'` 且带 `conversation_id`、`turn_id`、非空 `text` 的帧当作该 turn 的累计 live caption，后到的覆盖先到的。
- **带 `final:true` 且 `text===''` 的 caption 会撤回该 turn 的 live caption。**
- turn 的持久化消息出现（同 `turn_id`）时 live caption 被丢弃。所以预览 caption 使用的 `turn_id` 必须和最终落库消息的 `turn_id` 一致（即现有 `caption` 帧里的 `turn_id`，不要另造）。

## 验收

单测（`runtime/test`，沿用现有测试风格和夹具）：
- provider：`previewText:true` + 带工具时，纯文本回复先收到多个 `text_preview`，`stop` 时收到完整 `text_delta`，预览拼接 === 完整文本；`previewText` 缺省时事件序列与改动前完全相同（回归）；`tool_calls` 结尾的回复只有预览、没有 `text_delta`，且 `tool_call` 事件和 history 记录与改动前一致。
- adapter（`textOnly`）：预览产生逐段 `response_transcript_delta`，`stop` 后不重复；"预览 → tool_call"不触发 `cascaded_mixed_text_tool`，并发出空文本 final 撤回；语音模式下预览被忽略、行为不变。
- workbench：Plan/Build 的 caption 随预览增长；"预览 → 工具调用 → 权威文本"序列的 caption 内容正确。
- 既有测试全部通过（至少 `workbench-runtime`、`native-conversation-runtime`、`personal-conversations`、cascaded adapter/provider 相关）。

实机验收（用户已批准使用原始 profile，规则同 `ACCEPTANCE.md` 的修订）：在**新建对话**里复测阶段 A 的时间线：第一个增量可见时间应显著早于完整回复可见时间，增量次数 > 1；再测一个会触发工具调用的提问，确认没有残留的预览气泡、没有 `cascaded_mixed_text_tool`、最终回复正确落库。

## 约束

- 只改 `runtime/`；不引入新依赖和环境变量；风格与周边代码一致。
- 日志与编译产物写到外置盘，不要写进仓库树（auto-checkpoint 会把它们提交）。
- 不要 push；在你自己的 worker 分支上提交，整合由主控完成。

## 2026-10-28 修订：P4 输出上限与 P8 首段保留

上一版契约的"预览 → tool_call 一定撤回"会让用户在工具轮之后丢掉首段口播。实测还发现真实模型在输出上限处静默截断，界面只留下半句。本次修订替换第 4、5 条中的撤回语义，并新增输出上限的失败与续写契约；渲染端约定（`final:true` + `text:''` 撤回、同 `turn_id` 覆盖）不变。

### P8：一个用户轮次一个转写

1. provider（Chat Completions 与 Ark，仅 `previewText:true`）：工具决策前的文本不再只是可撤回预览。`finish_reason='tool_calls'` / Ark `response.completed` 带工具时，先在 `tool_call` 之前补发一次权威 `text_delta`，内容与该轮预览一致；语音（未开启预览）行为不变，仍然完全不向 TTS 暴露。
2. `adapter.ts`（`textOnly`）：`tool_call` 不再发 `text:''` 的 final，也不清空已累计的转写；`response_completed` 带待执行工具时只发 `tool_call_ready`，narration 以非 final 的 delta 留在同一轮。语音路径保持原有撤回/TTS 行为。
3. `conversation-runtime.ts`（文字模式）：`runTurn` 为每个用户轮次维护 `turnTexts` 槽位，一个响应一个槽位；同一响应的增量按 `startsWith` 覆盖，跨工具响应按 `\n\n` 合并（`mergeTurnText`，与 workbench 共用）。`response_started` 不再清空进行中的轮次；首个 caption 的 `turn_id` 被固定为该轮的唯一 turn_id，后续响应（工具续写）全部复用它，最终 `runTurn().assistant` / `turn_id` 与落库消息一致，因此首段一定在最终回复里。后台任务/语音响应不走该合并，仍按响应各自成轮。
4. `workbench-runtime.ts`：turn id 与累计文本提升到一次 `run()`（一个用户轮次）作用域；工具轮不再撤回 narration，预览在 `tool_call` 时提交为权威文本；caption 最多 4000 个码点，**保留头部**（此前 `slice(-4000)` 保留尾部，导致首段被截掉）；最终 `assistant`、`state.assistant`、长文 `saveReply` 都用整轮合并文本。
5. 失败或暂停仍可用 `final:true` + `text:''` 撤回未落库的临时 caption；工具边界不再是失败，因此不撤回。

### P4：输出上限是一等失败，可续写

1. Chat Completions 请求显式发送输出上限：`deepseek/qwen/gemini/ark/默认 8192`、`openai 16384`（用 `max_completion_tokens`，其余用 `max_tokens`）；Ark Responses 发送 `max_output_tokens: 8192`。不把上限交给 provider 默认值，截断才可检测。
2. 新增失败码 `output_limit`。Chat Completions `finish_reason='length'` 时：文本模式下先释放为权威 `text_delta`（工具决策前的 narration），再发 `response_failed{code:'output_limit',detail:'length'|'tool_arguments'}`；未发出的工具片段绝不产生 `tool_call`，`checkpoint.pending` 不落入半截参数，宿主可原样重放该轮。Ark `response.incomplete` 映射为 `output_limit` 并保留可展示 narration。
3. `workbench-runtime.ts` 自动续写（均以失败轮之前的 checkpoint 重新开会话，避免重复 user turn）：
   - 文本截断：追加 `host_context`（`purpose:'output_limit_continuation'`，带 `previous_partial` 尾部与"从截断处继续、不重复"指令），每个 `run_version` 最多 2 次；
   - 工具 JSON 截断（`detail:'tool_arguments'`）：本轮不执行任何调用，追加 `host_context`（`purpose:'output_limit_tool_split'`）要求拆成多次较小串行调用，最多重试 1 次；
   - 仍失败：`status='paused'`、`reason='model_output_limit'`，返回可读文案（区分工具截断/文本截断）；`model_failure` 保留供诊断。
4. Resume 是控制动作，不产生用户消息：`workbench-runtime` 接受 `context.resume===true` 且忽略 turn 文本，需要触发时只追加 `host_context{purpose:'resume_control'}`，不再合成 `user_text`。宿主需继续以 `context.resume` 调用 `runTurn`，并保证不新增可见用户行。

### 验收（`runtime/test`）

- `realtime-cascaded-output-limit.test.ts`：上限字段表；`length` 释放文本并返回 `output_limit`（可重放）；工具参数截断无 `tool_call`。
- `realtime-cascaded-qwen/ark-llm`：工具决策前文本模式补发 narration；Ark `incomplete → output_limit`；`max_output_tokens` 断言。
- `realtime-cascaded-adapter`：preview → tool_call 不撤回、无空 final；preview → tool → 续写保持同一轮。
- `conversation-tool-continuation`：pre-tool narration 与续写合并为一条最终回复，caption 只有一个 turn_id。
- `workbench-runtime`：首段保留、稳定 turn_id、上限续写两次、截断工具 JSON 拆分重试一次、head-preserving caption、Resume 无可见用户气泡。
