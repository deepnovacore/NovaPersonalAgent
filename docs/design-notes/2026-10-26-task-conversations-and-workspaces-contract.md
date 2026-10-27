# 任务即对话 + Nova 自有工作区：契约

日期：2026-10-26。来源：用户在验收截图上的两条澄清。范围同时涉及 `runtime/` 和 `clients/desktop/`，实现交给 worker，主控只审查。

## 用户意图（原话要点）

1. 左侧 nova 对话栏**不允许切换对话**；切换对话的功能就是右侧的"任务"：**任务即对话**。
2. 工作区：每个执行器有自己的工作区体系，Nova 自己也有（`~/.nova-audio-agent/workspaces/`，用户口述的 `~/.nova-personal-agent/workbench-workspaces` 是同一个意思，磁盘上实际路径以代码为准）。内置 Build 的工作区应在 Nova 自己的体系里实现，而不是任意文件夹选择器。
3. 执行器调度里目前**没有**默认 session（已核实：`CodingTargetController` 注释"Global project/session focus is never a default here"，无项目时 `kind:'create'` 新建托管项目）。本契约不引入默认 session，只在文末列为待用户决定。

## 现状（已核实）

- 托管根目录 `productPaths().managedRoot = ~/.nova-audio-agent/workspaces`，其中 `default/` 是主机批准的 Codex 工作区，其余是 `名字-哈希` 的托管项目（`runtime/src/projects/*`，`executors/codex/factory.ts`）。
- `conversations.targets` 已返回托管项目的 `{workspace_id, project, directory}` 列表（Codex 目标）。
- 左栏 `chat-pane.mjs` 顶部有会话下拉 + "新对话"（`renderConversations`），右栏任务 tab 现在是委托任务记录（`tasks-page.mjs`）。
- 宿主只有一个 `conversations.selected_id`，语音也只归属一个会话（`voice_id`）。**保持这个单选模型**，不做左右两个同时活动的会话。

## 设计 A：任务即对话（桌面端为主）

- 左栏：删除会话下拉、"新对话"按钮和所有切换入口。左栏永远显示"当前选中的会话"，标题只读；有一个"返回主对话"的小按钮（仅当选中的不是 `chat:main` 时显示）。
- 右栏"任务"tab 是**唯一**的切换入口：
  - 列表：按最近更新排序，分组"近 7 天 / 更早"，每项显示标题、最近一条消息摘要、状态（进行中 / 待你处理 / 已完成 / 失败）。数据来自 `conversations.items`（排除 `chat:main` 与 `kind:'schedule'`；Build 会话 `kind:'build'` 和 plan/普通 topic 会话都算任务）。
  - "创建任务"按钮 → 新建会话并选中（沿用 `c.create()`），左栏随即显示它，模式按钮可选 Chat/Plan/Build/Delegate。
  - 点击一项 → `c.select(id)`，左栏显示该会话。当前选中项高亮。
- "定时任务"子 tab 保持不变；原"委托任务记录"列表移到任务项详情里（会话里已有任务状态，不再单独一页），执行器输出仍走悬浮窗，不回到任务页。
- 可见的待审批/未读标记：会话 badge 逻辑从下拉里搬到任务列表项上（`waiting`、`unread_count`、语音中、发送中）。
- 测试：`chat-pane.test.mjs`、`tasks-page.test.mjs`、`personal-view` 相关里依赖会话下拉的用例改成走任务列表；新增：左栏没有任何会话切换控件、任务列表切换会话、创建任务、"返回主对话"仅在非主对话时出现、分组正确。

## 设计 B：Nova 自有工作区

- 新增 host 命令 `workspaces.list`（只读）和 `workspaces.create {name}`：
  - `list` 返回托管项目 `[{workspace_id, name, is_default, last_used?}]`，**不含绝对路径**（沿用 `CodingTarget` 的"只含公开标签和不透明 ID"约束）；`default` 排第一。
  - `create` 在 `managedRoot` 下用现有项目存储的创建逻辑建一个新托管项目（slug+哈希，已有的 `ensure*`/`ProjectStore` 能力），返回新项的 `workspace_id`。名字只允许合理长度和字符，重复名由现有 slug+哈希机制消解。
- `build.begin` / `build.start` 接受 `workspace_id`（托管项目）**或**保留的 `project`（任意目录，作为高级选项）；二者互斥，缺省 = `default` 托管工作区。运行时把 `workspace_id` 解析成目录再走现有 `canonicalProject`、`projectResourceKey`、`taskResourcesBusy`。
- 桌面端工作区条（`workspace-bar.mjs`）和计划卡（`workbench-agent.mjs`）：
  - 内置 Build：选项 = 托管工作区列表 + "新建工作区…" + 次级项"其它文件夹…"（沿用现有目录选择器，标注为高级）。默认选中 `default`，显示名"默认工作区"。
  - Codex：选项 = 它自己登记的目标（现状已是，沿用）。其他 ACP 执行器：不显示工作区（现状已是）。
  - 不再在界面里显示绝对路径；悬停可看目录名。
- 测试：host 命令的单测（list 不含路径、create 落在 managedRoot 下、`workspace_id` 与 `project` 互斥、非法名字被拒、`default` 缺省）；`workspace-bar` 和计划卡的组件测试；既有 `build.begin` 用 `project` 的测试保持通过。

## 约束

- 保持单选会话模型和语音单归属；不改 `conversations.select` 语义。
- 预研产品，不写迁移层（旧状态直接重置即可）。
- 不引入新依赖和环境变量；风格与周边一致。
- 日志与构建产物写外置盘 `/Volumes/sqxh-junjie/nova-builds/`，不要写进仓库树。
- worker 在自己的分支提交，不 push；主控审查后合入。

## 待用户决定（本契约不实现）

- 是否需要一个**默认 session**：为"非专项的简单操作"（打开应用、查个东西）长期复用 `workspaces/default` 里的一个编码会话，避免每次新建一个 `打开飞书桌面应用-…` 项目目录。当前行为是每次新建。GUI 类简单操作本来就走独立的 `computer` 执行器，不经编码会话。
