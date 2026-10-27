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
