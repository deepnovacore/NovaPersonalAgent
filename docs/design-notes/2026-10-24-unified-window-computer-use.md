# Issue #3：统一面向窗口的 Computer Use

## Context

Issue #3 提出：Build 的 `computer_run` 再套一层独立 GUI 模型，Build 与语音下游执行的观察协议不统一，AX 只在 macOS 后台绑定窗口时才有。要求以“目标应用窗口”为统一对象。

基线：`feature/build-computer-use` 与 `fix/build-cu-acceptance-example`（worktree `/Volumes/External/nova-builds/build-cu-example/worktree`）都**已合入 v1.0.0dev**（后者领先 0 个提交），所以直接从 v1.0.0dev 开新分支，不需要接那两个分支。

## 架构是否合理（结论：合理，按下面三点收窄）

核对代码后，issue 的事实描述属实：
- `computer_run` 经 `conversation-tool-bridge.ts:37` 派给 `ComputerExecutor`，再进 `gui-runner.ts` 的 Midscene `aiAct`，Build 模型之外多了一个 GUI 规划器（`COMPUTER_MODEL` 独立配置）。完成后 `workbench-runtime.ts:149-151` 只拍一张宿主截图就把 `verificationRequired` 清零，与执行结果无关。这正是 issue 说的“回执代替验证”。
- AX 摘要与编辑框状态仅在 `session.ts:77-81`：`macWindow && selectedTarget` 才取，而这两者只在本次传了 `application` 时设置。
- 底层锁、设备守卫、后端、资源互斥已共享（`device-lock.ts`、`computer-device.ts`、`computer-backend.ts`），所以统一的成本主要在观察协议，不在驱动。

收窄点：
1. **Midscene 是视觉优先框架**，规划器每步只吃截图；它唯一的文本入口是 `aiAct(..., {context})`，且是任务开始时的一次性静态文本（`gui-runner.ts` 已经在传 `context`）。所以语音下游**不重写为原子循环**，统一到“共享会话/观察/动作层”，AX 摘要只作为带观察标识的启动上下文，不承诺逐步刷新。
2. **Windows 无 UIA**（`clients/desktop/native/windows` 只有 job guardian，前台身份来自 PowerShell）。本期只定接口，Windows 返回明确 `ax: unavailable`。你已确认。
3. **去掉 `computer_run` 后，不支持视觉的 Build 模型将没有任何桌面工具**（现在它们靠 `computer_run` 兜底，`contract.ts:26`、`workbench-runtime.ts:107`）。必须给出明确的能力限制提示，而不是静默。

## 设计

### 观察协议（新，`computer-use/contract.ts`）
`ComputerObservation`：`id`、`image`（缩放后）、`space`（截图长边/逻辑尺寸/缩放比）、`target`（应用、pid、windowId、标题）、`focus`、`ax: {status: 'ok'|'unavailable'|'timeout'|'truncated', summary?, editor?}`、`foreground: boolean`。动作必须携带 `observationId`，会话在执行前核对目标身份和窗口几何，不匹配则拒绝并要求重新观察。

### 会话（`computer-use/session.ts`）
- 目标窗口无论前后台都尝试读 AX：去掉 `macWindow && selectedTarget` 门槛，改为“目标解析成功即读”。
- 新增 `executionMode` 记录：`background | activated`；需要激活窗口时走显式策略（默认拒绝，需应用授权），实际方式写入工具结果与调用日志。不静默抢焦点。
- 修复疑似缺陷：`session.ts:48` 把环境变量 `macWindow` 传给后端，Build 不带 `application` 的截图可能绑到环境窗口，与 `skill.ts:10`“无 application 即全屏”矛盾。目标来源统一由会话解析。
- 明确动作语义：`computer_type` 增 `mode: 'append' | 'replace'`（Swift 侧 AX setValue vs 逐字符事件目前行为不同）。
- Build 的 wall-clock 超时补齐（现在只有 turn signal）。

### Build（`workbench-runtime.ts`、`tools.ts`、`skill.ts`、`workbench-instructions.ts`）
- 删除 `computer_run`：schema、工具描述、两处提示词、`conversation-tool-bridge` 的 `computerRun`、`:145-151` 分支。
- 完成判断依赖动作后的新观察；删除 `verificationRequired=false` 的无条件清零。
- 非视觉模型：保留“仅能读取 AX 文本”不现实，直接提示“当前模型无视觉，Build 桌面操作不可用，请换视觉模型”。

### 语音下游（`executors/computer*.ts`、`gui-execution.ts`）
- `computer-device.ts` 的 Midscene 接口改为调用同一个 `ComputerSession` 的观察/动作，而不是各自一套；坐标映射统一用 `space`。
- 任务开始取一次观察，把 `ax.summary`（带 `observationId`、“可能已过期”标注）拼进 `aiAct` 的 `context`。
- 语音前脑仍派发完整任务，接口不变。

### 原生（`macos_gui.swift`）
- `editor` 返回 AX 状态码（超时/截断显式标记）；已有 80 条/300 字符上限保留。
- 不新增私有 API 依赖。Windows 不动。

### 安全
截图与 AX 内容视为不可信应用数据：进入模型前加边界标记、限长，密码类字段（AXSecureTextField）值不读。

## 派发

- 执行者：**一个 Codex worker**（你指定）。我负责设计、审查、整合与最终验证；subagent 优先 haiku。
- 分支：从 v1.0.0dev 新建 `feat/unified-window-computer-use`（以 AGENTS.md 要求，构建输出放 `/Volumes/External`，按 worktree 路径+chat ID 命名；先确认已挂载，已确认当前挂载）。
- 注意：omx 的 worker worktree 默认建在 `<repo>/.omx/team/...`（内置盘），只放源码；构建/测试输出必须通过环境变量指到外置盘并写进任务说明。`.omx/` 用 `.git/info/exclude` 排除。
- 先提交契约文件（`contract.ts` 的 `ComputerObservation`），worker 才看得到。
- 启动前检查：`$TMUX`/`$TMUX_PANE`，不在 tmux 内则先告知，不假装。
- 任务拆分（有依赖，串行为主）：①契约+会话（观察/目标解析/执行模式/追加替换）②Build 去 `computer_run` + 提示词 + 非视觉提示 ③语音执行器接入共享会话与 AX 上下文 ④测试与文档。①完成并经我审查后再派 ②③。
- 不涉及公开/内部分支规则的资产与角色内容；只合入 v1.0.0dev，不推送（push 规则沿用：先 fork，确认后再 origin，你没让我推我就不推）。

## 验证

- `runtime`：`computer-use.test.ts`、`workbench-runtime.test.ts`、`conversation-computer-bridge.test.ts`、`computer-device.test.ts`、`executors-computer.test.ts`、`gui-runner.test.ts` 更新并新增：观察标识失配拒绝、目标窗口变化、AX unavailable/timeout/truncated、取消、不确定写入隔离、环境窗口不泄漏到无 `application` 的调用、`computer_run` 不再出现在任何工具列表或提示词中（grep 断言）。
- `clients/desktop/test/computer-use-ui.test.mjs`、`macos-gui-native.test.mjs` 同步。
- 文档：`docs/en|zh-CN/executors/computer-use-build.md` 重写（现在还停留在环境变量绑定，漏了 `application`），`docs/verification/build-computer-use.md` 更新验收清单。
- 真机：macOS 后台窗口的 AX/截图、激活策略需要在真实 Mac 上走一遍；Windows 无法验证，报告里如实标注“仅接口、AX unavailable”。
- 最终：在 v1.0.0dev 上合入后跑 runtime 全量测试与类型检查，再向你报告已实现/已整合/已验证的差别。
