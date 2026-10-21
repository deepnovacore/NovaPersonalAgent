# Build 中的 Computer Use

Computer Use 是 macOS 和 Windows 本地 Build 会话的可选能力，需要逐会话开启。Plan 永远不会获得电脑工具。关闭开关会撤销访问，并停止当前 Build 回合。

## 配置

复用现有电脑执行器配置：`COMPUTER_DISPLAY_ID`、`COMPUTER_BASE_URL`、`COMPUTER_MODEL`、`COMPUTER_MODEL_FAMILY`、`COMPUTER_API_KEY`。步数、超时、画面稳定等待和点击时长分别由 `COMPUTER_MAX_STEPS`、`COMPUTER_TIMEOUT_SECONDS`、`COMPUTER_SETTLE_MS`、`COMPUTER_CLICK_HOLD_MS` 限制。取值和默认值以自动生成的环境变量参考为准；凭据只放在本地配置中，不写入项目。

macOS 需要授予桌面应用屏幕录制和辅助功能权限。Windows 需要打包的进程守护组件。全桌面控制要求仅有一个已配置显示器。可选的后台 Safari 窗口模式使用 `COMPUTER_MAC_WINDOW_PID` 和 `COMPUTER_MAC_WINDOW_ID`；Connect 审批必须说明目标窗口和临时键盘焦点行为。

从本地桌面的 Build 会话开启开关。预检会列出不支持的平台、无效配置和缺失权限；远程客户端不能授权开启。

## 工具与模型

支持视觉的 Build 模型可以截图、点击、输入、滚动、按快捷键，也可以用 `computer_run` 同步委派整件界面任务。坐标基于最近返回的截图，截图长边最多为 1280 像素；每次点击或滚动前需要新截图；点击输入框后可以直接输入和按键。

当前 Build 视觉模型白名单：

- Qwen：`qwen3-vl-plus`、`qwen3-vl-flash`、`qwen-vl-max`、`qwen-vl-plus`。
- StepFun：`step-3.7-flash`。
- Ark：`doubao-seed-2-0-pro-260215`。

其他模型标识不会被默认视为支持图片：仅开放委派，并在预检中提示 `vision_model`。Build 模型与电脑执行器的 `COMPUTER_MODEL` 是两项独立配置。

## 审批、Stop 与恢复

每次新建直接控制租约都需要 Connect 审批。本地工具审批为 `ask` 时，每个输入也要批准；为 `never` 时，Connect 仍然需要批准。委派任务继续使用执行器本身的审批流程。

Stop 会中止回合并等待后端清理，关闭开关也是如此。超时或未确认清理不代表成功：不确定输入记录为 `outcome_unknown`；设备清理不确定时，保留资源和设备两层隔离。不要删除锁来强行继续操作。

Resume 后必须先取得新截图，才能直接输入。发生输入后，必须有更新截图才能结束 Build；委派会返回最终观察。执行器模型宣告结束，本身不构成用户目标已完成的证据。

截图是仅限所有者访问的私有 Build 文件。日志只记录引用，不保存图片字节；模型历史仅保留最新两张图，更早的替换为文本占位。发送给所选模型的截图可能包含屏幕上的敏感内容。

## 验收状态

自动化测试使用 fake 后端，不操作真实屏幕。单测通过不等于 macOS 或 Windows 实机验收。实机必须另行检查权限、坐标准确性、审批、Stop/Resume、并发任务所有权，以及桌面提示层是否对用户可见、对模型截图不可见。

同步委派桥接、Build 模型能力配置和执行器排队行为仍需联合集成验证。本配置指南不是发布记录，也不是实机验证记录。

macOS 和 Windows 请分别执行[实机验收清单](../../verification/build-computer-use.md)，不要把单测结果记为实机通过。
