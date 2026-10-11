# v0.4.0 进度

2026-09-11：按用户要求承接 M8 及之后的里程碑。2026-09-12：M8 邮件/日历与飞书 IM 拉回 v0.3.0（M8-Mail、M8-IM），
本版只剩 M9。以上为历史规划；当前 coding 实测状态见下文。

| 里程碑 | 一句话 | 依赖 | 退出条件 | 状态 |
|---|---|---|---|---|
| **M9-C** 多 coding 后端 | OpenCode、CodeBuddy、Pi、DeepSeek Harness 接入既有 coding 调度、审批、进度、取消 | v0.2 执行器/审批契约；不依赖 M7/M8 | 每个后端独立通过工作闭环及拒绝/取消/失败场景，支持矩阵明确 | 🟨 已接入并实跑；整体未验收 |
| **M9-G** GUI 执行器 | 以 AutoGLM 为首个 example，绑定设备与动作授权 | v0.2 执行器/审批契约；不依赖 M9-C、M7/M8 | 真机执行、拒绝、中途取消和状态不明场景通过 | 🟨 已实现，部分 live 验证；真机和产品验收未完成 |
| **M9-Demo** agent2agent | Nova 委派 coding/GUI 专长 agent 的复现说明与真实演示 | M9-C、M9-G | 版本/平台/权限/产物/限制完整，不把协作演示称为未经验证的 A2A 协议兼容 | ⬜ 未开始 |

完整要求见 [执行器](02-coding-and-gui-executors.md)。

2026-10-04：基于 `v0.4.0dev@d425dcb5` 开始独立项目实跑。四个 ACP 后端
及 Codex 均已生成可玩的俄罗斯方块，浏览器机制检查通过；但 Task 收口、
证据契约、原会话续做仍有阻塞，不能签整体 live 通过。部分证据补丁仅在本地
验收分支验证，尚未合并；GUI/语音/打包产品不属于本轮覆盖。
详见 [coding live 验收记录](../../testing/v040-coding-live-acceptance.md)。

2026-10-05：对 Oct-5 四后端 `task_check_unavailable` / Pi 重启
`task_origin_unavailable` / 续接 `unknown_session` 完成根因确认与本地修复
（未提交、未合并）。回放表明验证器回复为合法 `complete`，但 `criteria` 下标
越界被 `applyDecision` 拒绝并被吞成无诊断 waiting。修复包括：验证器阶段诊断 +
一次带 `validation_feedback` 的预校验重试、证据 64KB 保留最新观察、Blackboard
按通道公平淘汰、同 generation 恢复保留 `coding_target`，以及 transport/intake/
live 驱动的审查加固。本地 `runtime` 全量测试 3459 通过。

同日补齐错误原因透传（intake 失败的 schema 路径、验证器修复提示、ACP 失败的
固定分类诊断）后锁定模型原因：`qwen-flash` 会照抄前台改写的约束、`qwen-max`
验证器 JSON 类型稳定写错；`qwen3-max` 两项均通过（级联 Qwen 下 support/planner/
compressor 跟随前台模型）。`qwen3-max` live 重跑：DeepSeek Harness、CodeBuddy、
OpenCode、Pi 四个后端的原 Task、切换默认后端后原会话续做、重启后原会话续做全部
`completed`，首轮自然语言直接派发，后端身份与会话固定。DeepSeek 重启续做先因账户
402 失败，充值后按 `not_run` 对账并继续原 Task 完成；Pi 充值后从头重跑通过。期间
修复会话标题上限不一致、重启后续做被误追问、派发异常原因被吞三处缺陷。M9-C 的
runtime 文本工作闭环已通过；拒绝/取消/崩溃、GUI/语音/打包仍未覆盖。compressor 在
ACP 执行期间空转（约占 `qwen3-max` 输入的 91%），延后在 `v0.3.0dev` 独立 worktree 修复。

## 2026-10-11 集成检查

公开 `origin/main@208ad5a8` 已合入 `v0.4.0dev`，合并提交为 `8c770208`。
GUI 集成包含 `feature/gui-execution@5758925c` 与该工作树的后台 Safari 原生输入候选；
GPT-6 Astra 审查发现的 Connect 授权复查、非文本剪贴板丢失及强杀后输入释放问题已修复并复核。
这不代表 v0.4.0 整体验收或发布通过。

当前剩余事项：

- **计划范围已确认：** 2026-10-11 用户明确不接入 Kimi Code；M9-C 以 OpenCode、CodeBuddy、Pi 和 DeepSeek Harness 四个 ACP 后端为范围。
- **M9-C 异常路径实跑：** 已有四后端文本 Task 完成、默认切换后的原会话续做、重启续做记录；本轮已真实覆盖拒绝、运行中取消、崩溃及凭据恢复，发现未通过项，详见 [异常路径实跑](../../testing/acp-failure-acceptance-2026-10-11.md)。CodeBuddy 四项通过；OpenCode/Pi/DeepSeek 崩溃后仍有工具副作用，Pi 401 误报完成，DeepSeek 普通写入无审批且凭据恢复后的新任务未生效。M9-C 整体仍未通过。
- **模型与权限边界：** 已有成功记录依赖 `qwen3-max`；较弱模型的派发与验证稳定性未被重新签收。ACP Ask 模式没有 Codex 等价的文件/网络沙箱，Pi 无逐项审批，ACP 不支持运行中追加要求；这些限制已明确展示，不算新增后端的等价能力。
- **M9-G 真机与完整任务：** browser、computer、mobile 已接入共享审批、取消、截图证据和 Task 核验；浏览器完整任务及部分 Mac 读回有历史 live 证据。后台 Safari 原生动作链通过，但完整真实模型 Task 曾受 TLS 失败阻塞；手机真机、Windows、麦克风语音取消及签名安装包/TCC 验收仍未完成。
- **M9-Demo：** 缺按后端/设备独立制作的合成数据演示、授权与失败路径录屏、复现配置及最终支持矩阵；既有测试记录不等于交付完整演示材料。

旧记录中的 verifier、原会话续做和 ACP 压缩器空转修复现已在此分支，
不再列为“尚未合并”。压缩器修复的证据见 [2026-10-06 验证记录](../../verification/acp-progress-compression-2026-10-06.md)。
GUI 边界与历史证据见 [通用执行](../../verification/gui-execution-2026-10-07.md)
及 [后台 Safari](../../verification/gui-background-mac-2026-10-07.md)。

本轮用户明确暂缓依赖外接盘 Xcode 的原生构建、设备与安装包验收；其余自动化检查在当前集成代码上执行。

本轮验证：运行时完整回归 **3632 通过 / 0 失败 / 9 跳过**；电脑执行器相关 **24/24**。
类型检查、runtime lint、环境契约与能力清单检查通过。桌面非 Swift 测试通过，
Electron 首次解压竞争后的 orb 单独复跑 **7/7**；三项需要 Swift 构建的测试明确暂缓。
未重跑真实模型 GUI、物理语音、Windows 或签名安装包验收。
