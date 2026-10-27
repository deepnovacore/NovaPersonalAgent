# 模式重构：运行时契约（Plan / Build / Delegate / 实时对话）

日期：2026-10-26。范围：`runtime/` 与 wire 协议。桌面渲染端（composer、plan 卡、悬浮窗、聊天流）由主控实现，运行时只需满足本契约。

## 背景

现状：composer 选 Build 只是把会话切到 `mode:'plan'`，模型只能 `publish_plan`；用户在 plan 卡上点按钮才由 `build.start`（`host.ts`）创建 `kind:'build'` 会话并执行。Build 会话要求已确认的 plan（`conversation.build.plan_id/plan_version`）。plan 与 build 会话都禁止语音（`conversation-runtime.ts` 的 `workbench_text_only`）。

目标：

1. Build 可以不经 plan 直接执行（读/写/编辑/shell 的 ReAct，同步）。
2. Plan 是独立模式：只读工具 + `publish_plan`，可先澄清；plan 之后由用户选 Build 或 Delegate。
3. Delegate 到本机执行器时可指定工作区。
4. 任意模式都能切入实时对话，上下文来回切换不丢。

## 任务 R1：无 plan 的直接 Build

- 新 host 命令 `build.begin`，参数 `{text:string, project:string, title?:string}`（严格 schema）。行为：校验 `project` 为已存在的目录（沿用 `canonicalProject`、`projectResourceKey`、`taskResourcesBusy`、`activeLocalBuild` 的现有检查与错误码），创建 `kind:'build'` 会话并选中，随后以 `text` 作为首条用户消息提交（沿用 `build.start` 的失败回滚逻辑）。
- `conversation.build` 的 `plan_id`、`plan_version` 改为可选；所有读取处（`workbench-runtime.ts` 的 `confirmedPlan`、`workspaceContext`、`conversations.ts` 的 schema、`build.details` 等）要在无 plan 时正常工作。已落盘的旧状态按"预研产品不做兼容"处理：不写迁移，旧状态可以重置。
- `workbench-instructions.ts`：`build` 分支区分"有已确认计划"和"直接 Build"。直接 Build 的提示词要求：不要先输出计划，直接读取、修改、验证；只有被缺失信息阻塞时才简短询问；其余约束（审批、同步、`finish_build`）保持不变。
- 不改 `LOCAL_TOOLS` 的工具集合与审批逻辑。

验收：新增单测覆盖 `build.begin` 成功、目录无效、重复/并发拒绝、无 plan 会话的 checkpoint 恢复与 `build.resume`；`workbench-runtime` 在无 plan 时不引用 plan 字段；既有 plan→build 路径的测试全部仍通过。

## 任务 R2：delegate 指定工作区

- `plans.delegate` 增加可选参数 `project?:string`（执行器工作区目录）。提供时，经现有 coding target 机制（`CodingTargetController` / `rememberCodingTarget`）把该目录设为这次 dispatch 的目标工作区；未提供时行为与现在一致。
- 工作区被占用时返回现有的 busy 错误码，不新增隐式回退。
- 先阅读 `coding-targets.ts` 判断可行性。若 `CodingTarget.executor` 仅限 `'codex'` 导致其他执行器（ACP 后端）无法承载，不要扩大范围：在结果里写明阻塞点并只实现 codex 路径。

验收：单测覆盖带 `project` 与不带 `project` 两种调用、busy、非法目录。

## 任务 R3：plan/build 会话中的实时对话与上下文交接

- 去掉 `conversation-runtime.ts` 里对 plan/build 会话的 `workbench_text_only` 限制（`conversations.voice` 仍保持"同一时刻一个会话持有语音"）。
- 进入语音时，向语音会话注入 `dialogue_context`（沿用现有机制，参考 `conversation-runtime.ts` 中 references/todos 的注入方式）：
  - 会话摘要（超过 N 条时对更早的消息做摘要；摘要可由现有摘要/记忆能力或简单截断实现，选最小方案并在代码注释里说明）；
  - 最近 N 条消息（建议 N=12，常量化）；
  - 当前状态：plan 会话带最新 plan 标题与版本；build 会话带项目目录、`build.status`、是否有待审批。
- 语音期间的转写写回同一会话的消息列表（沿用现有语音转写落库路径）。
- 语音结束回到文字模式时，plan/build 的 workbench 运行时必须能看到语音期间产生的新消息：把这些消息作为 `host_context` 输入追加到下一轮（参考 `workbench-runtime.ts` 对 `previous_message` 的 host_context 处理），避免模型"失忆"。
- 语音模式下 plan/build 的写操作仍不可执行：语音只负责对话与澄清，不触发本地工具；如需执行，提示用户回到文字模式确认。
- 反方向（文字→语音→文字）和（chat→语音→chat）都要有测试。

验收：单测覆盖 plan 会话与 build 会话各一次"文字→语音→文字"往返，断言注入的上下文字段、转写落库、回到文字后下一轮输入包含语音期间消息；既有语音测试不退化。

## 约束

- 只改 `runtime/` 与必要的 wire schema/fixture；不要修改 `clients/desktop`。
- 不引入新依赖；不新增环境变量（如必须，同步 `environment-contract.ts` 并通过 `check:env-contract`）。
- 命名与风格与周边代码一致，注释密度与现有文件一致。
- 通过 `npm run check` 与 `npm run test:runtime` 中与改动相关的测试。构建输出走外置盘，不清理共享目录。
- 不要 push；提交到 worker 分支即可，整合由主控完成。

## 渲染端将调用的接口（供对齐）

- `build.begin {text, project, title?}`
- `build.start {id, plan_id, version, project}`（不变）
- `plans.delegate {id, plan_id, version, executor, project?}`
- `conversations.voice`（plan/build 会话可用）
- `conversations.mode {id, mode:'chat'|'plan'}`（不变）
