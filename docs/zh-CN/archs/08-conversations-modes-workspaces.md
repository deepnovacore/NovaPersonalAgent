<a id="8-会话模式与工作区"></a>
# 会话、模式与工作区

**会话**是你与Nova交流的单位；**工作区**是本地 Build 或编码会话执行时所在目录的单位。本章说明 桌面宿主中两者如何连接、Workbench 的四种模式如何路由工作，以及宿主用哪些状态阻止两个运行同时修改同一个目录。

## 会话种类

`conversations.ts` 定义四种 `kind`：

- `chat`——普通会话。`chat:main` 在启动时创建，是持久的主对话线程；Proactive 消息以 `origin: 'proactive'` 写入这里。
- `topic`——由资讯或卡片经 `conversations.open_feed` 打开。它按 `subject_key` 幂等，携带标记为 `untrusted_external` 的预备背景，绝不授予执行权限。
- `schedule`——为定时任务创建的隐藏运行记录。它不能被选中（`conversations.select` 会拒绝），不能持有语音，只有定时执行授权才能运行它。
- `build`——本地 Build 会话，由 `build.begin` 或 `build.start` 创建，带有自己的 `build` 状态。清空它会把会话重置为 `kind: 'chat'`、`mode: 'chat'` 并删除 build 状态。

会话还携带 `mode`（`chat` 或 `plan`）、可选的 `plan` 引用、`build`、`coding_target`、`generation`、消息和预备内容。客户端快照只暴露有界投影：`id`、`kind`、`title`、`last_message`、`generation_status`、`mode`、`plan`、`build`、`coding_target`、时间戳、`generation` 和 `unread_count`。

## 会话池与语音单归属

`ConversationRuntimePool`（`runtime/src/personal-agent/conversations.ts`）为每个会话维护一个运行时，并为每个会话保留一条轮次队列：同一会话内的轮次按顺序执行，不同会话可以并行。每个运行时都有模式——`text`、`voice` 或 `parked`——以及按 generation 限定作用域的 `AbortController`。`clear()` 会中止运行时，把仍持有任务的运行时移入退休集合（被取消的任务因此保留记录），并使 generation 失效；`canChangeTarget()` 在轮次、语音会话或工具运行进行中拒绝切换目标或模式。

宿主同时只有一个语音归属者，保存在 `conversations.voice_id`，由 `conversations.voice` 强制。开始语音会清空该会话的文字运行时并停止此前的语音会话；正在运行的 Build 上开启语音会被 `conversation_busy` 拒绝，而不是打断它。Plan 与 Build 会话可以持有语音，但持有期间模型拿不到工具：provider 的工具视图为空，工具调用会以 `workbench_voice_readonly` 被拒绝，并提示你回到文字模式确认执行。语音轮次的转写会写回同一会话。

## 四种模式

运行时契约见[模式设计说明](../../design-notes/2026-10-26-modes-runtime-contract.md)。四条路线是：

| 模式 | 做什么 | 入口与结果 |
|---|---|---|
| Chat | 普通对话、记忆、搜索和知识库工具；不分派任务 | 普通会话的默认模式 |
| Plan | 澄清目标并发布计划；只读工具加 `publish_plan` | 用户选择 Plan，客户端发送 `conversations.mode {mode: 'plan'}` |
| Build | 在逐操作审批下本地执行读、写、精确编辑和 shell 的 ReAct | `build.begin`（直接 Build）或 `build.start`（已确认计划） |
| Delegate | 把已确认计划交给执行器，并由任务循环跟踪 | Plan 会话中的 `plans.delegate {executor}` |

Chat 不能创建、取消或分派任务，不能创建定时任务，也不能通过模型工具切换模式；执行模式由用户选择。Plan 没有本地文件或 shell 工具，也不分派；它产出版本化计划，用户通过 `plans.edit` 编辑。Build 只在 macOS 与 Windows 上本地运行，并且一直可交互，直到调用 `finish_build` 锁定该会话。Delegate 需要当前计划引用，会校验执行器是已配置的 Workbench 执行器；同一计划版本已分派过时返回原任务，而不是重复创建。

## 直接 Build、Plan→Build 与 Delegate

- **直接 Build**（`build.begin`）跳过计划。宿主准入一个新的 `build` 会话，规范化工作区，取得项目资源锁，然后开始第一轮。
- **Plan→Build**（`build.start`）要求 `plan_id` 与匹配的 `version`；计划引用过期或不匹配会以 `plan_version_conflict` 或 `plan_session_stale` 拒绝，同一计划版本已有 build 时选中它而不是重复创建。
- **Delegate**（`plans.delegate`）要求 Plan 会话与已配置的执行器。执行器不接受 `workspace_id`（`workspace_unavailable_for_executor`）；显式 `project` 只对 Codex 执行器有效，并通过 coding-target 机制绑定。

## Nova 托管工作区

Nova维护自己的工作区，而不是每次都要求选择目录。托管根目录是 `~/.nova-audio-agent/workspaces`，其中 `workspaces/default` 是宿主批准的默认工作区。两个宿主命令负责暴露它：

- `workspaces.list` 返回 Nova 托管的工作区加上已批准的默认项，按最近使用排序，每项为 `{workspace_id, name, is_default, last_used?}`。它有意不含绝对路径，也不会列出任意导入的执行器项目。
- `workspaces.create {name}` 创建一个显示名唯一的托管工作区，并返回同样的公开结构。

`build.begin` 与 `build.start` 接受 `workspace_id` 或高级选项 `project` 目录，二者不能同时给出（`workspace_project_conflict`）；都不给时解析到默认工作区。宿主在使用前会规范化结果。执行器侧是另一套：Codex 保留自己登记的目标，ACP 后端不接受工作区选择。

## 资源锁

两个运行不能同时修改同一个目录。`canonicalProject` 把路径解析到真实位置，`projectResourceKey` 用设备号与 inode 作为归属键，使大小写不敏感的卷和别名共享同一把锁，而被替换的目录会得到新键（`runtime/src/executors/task-resources.ts`）。`taskResourcesBusy` 报告已被持有、正在等待或结果不确定的键，`acquireTaskResources` 会排在持有者之后，而不是随机失败。

本地 Build 在准入前检查一次，并在每轮开始前再检查一次，占用时返回 `project_busy`。停止结果未知时会把该键隔离，直到宿主拿到进程树已终止的确切证据；重启后会根据遗留的 shell 进程记录恢复隔离。

界面操作见[工作台](../workbench.md)，审批与权限配置见[设置](../settings.md)。
