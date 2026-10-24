# Build 中的 Computer Use

Computer Use 需要在 macOS 或 Windows 的本地 Build 会话中逐个开启。Plan 不提供桌面工具。关闭开关会撤销访问并停止当前 Build 回合；远程客户端不能授权开启。

## 配置与模型能力

当前实现复用电脑执行器配置：`COMPUTER_DISPLAY_ID`、`EXECUTOR_BASE_URL`、`EXECUTOR_MODEL`、`EXECUTOR_MODEL_FAMILY`、`EXECUTOR_API_KEY`。限制项为 `EXECUTOR_MAX_STEPS`、`EXECUTOR_TIMEOUT_SECONDS`、`EXECUTOR_SETTLE_MS`、`COMPUTER_CLICK_HOLD_MS`。凭据只放本地配置。Build 使用自己选定的视觉模型规划桌面动作，不再调用第二个 GUI 规划器；共享配置加载器目前仍会校验执行器模型配置。

macOS 需要屏幕录制和辅助功能权限；Windows 需要打包的进程守护组件。全屏控制要求仅有一个已配置显示器。平台、配置、权限和**视觉模型能力**中的任何预检失败都会阻止开启。

非视觉 Build 模型**没有桌面工具**。宿主返回 `vision_model_required`，明确提示“当前模型无视觉，Build 桌面操作不可用，请换视觉模型。”开启后切换成非视觉模型，同样会拒绝桌面调用。持久化字段 `direct` 为兼容已有数据而保留，由宿主重新计算当前视觉能力，不表示委派模式。模型是否支持视觉以 runtime 的能力检查为准，不根据任意模型名称猜测。

## 选择窗口与观察

macOS 下，调用 `computer_screenshot` 时传入 `application`，值为正在运行的应用的准确名称或 bundle ID。Nova 解析该应用自己的焦点窗口并绑定会话，不激活应用。找不到应用或名称有歧义会拒绝。需要后台启动时，先执行已获授权的 `/usr/bin/open -g -a` 命令。

新会话不传 `application` 时观察全屏；Build 不继承 `COMPUTER_MAC_WINDOW_PID` / `COMPUTER_MAC_WINDOW_ID`。已绑定窗口的会话后续观察仍保持该目标，换目标需要新会话。语音派发执行器可以显式绑定配置中的 PID/window ID。

共享观察包含：

- `id`、`captured_at` 和长边最多 1280 像素的图片。Build 日志保存 `image_ref`，不保存图片字节。
- `space.logical_width`、`space.logical_height`、`space.scale`，用于坐标换算。
- `target` 中的应用、PID、窗口 ID、标题；全屏截图时为 `null`。`focus` 和 `foreground` 描述前台身份。
- `ax.status`：`ok`、`unavailable`、`timeout`、`truncated`，以及可选的 `ax.summary` 和焦点编辑框 `ax.editor`。

macOS 对成功解析的前台、后台窗口都尝试读取 AX。Windows 明确返回 `ax: {status: 'unavailable'}`，本实现没有 UIA 读取器。AX 有长度限制，是不可信的应用数据，不是指令；不读取安全文本框的值。后台应用不重绘时，截图像素可能陈旧，应结合 AX 和后续观察判断，不能仅凭输入框文字就宣称提交成功或任务完成。

## 输入与观察有效性

五个工具为 `computer_screenshot`、`computer_click`、`computer_type`、`computer_scroll`、`computer_key`。

每次输入都必须将**最新观察的 `id` 作为 `observationId`** 传入。点击和滚动使用返回图片的坐标。每次输入后必须重新观察，才能继续输入，包括打字和快捷键。旧 ID 返回 `observe_required`；目标身份或几何变化返回 `screen_changed`。批准后还会再次校验身份，不自动重试结果不确定的副作用。

`computer_type` 支持 `mode: 'append' | 'replace'`，默认 `append`：

- `append` 在光标处输入；存在选区时，像正常打字一样替换选区。
- `replace` 覆盖整个焦点编辑框。后台不支持覆盖时会拒绝，不会悄悄改为追加。原生后台输入每次最多 200 个 UTF-16 单元，全屏输入最多 4000。

动作回执记录 `executionMode`：`background` 表示定向后台输入；`activated` 表示前台/全局输入，包括窗口本来就在前台的情况。后者**不证明 Nova 激活过窗口，也不是激活另一个窗口的授权**。后台操作不支持时，没有自动抢焦点的降级路径。

## 审批、资源所有权与验证

每个新会话需要 Connect 审批。`ask` 模式每次输入都要批准；`never` 仍需 Connect 审批。宿主处理已记住的应用级授权；实际输入前再次检查权限。

Build 和语音执行器复用会话、观察、动作处理及同一桌面资源租约。语音原有执行生命周期持有租约，共享会话不会重复加锁。语音仍由 Midscene 规划：AX 只在启动时进入 `aiAct` 上下文，标明观察 ID、时间、不可信来源及“**可能已经过期**”，不承诺每一步刷新规划器上下文中的 AX。

Stop/取消会等待有界输入回执和后端清理，会话总时限与步数限制仍生效。不确定的输入或清理不是成功；`cleanup_unknown` 会保留设备锁和资源隔离。不要删锁强行继续。Resume 必须取得新观察。Build 在输入后没有更新截图就不能结束；成功回执或模型宣告结束，本身也不是用户目标已达成的证据。

截图属于仅限所有者访问的私有文件；模型历史仅保留最新两张图。发送给所选模型的图片和 AX 可能包含应用中的敏感内容。

## 验收边界

fake 设备或本地脚本规划器的测试，不能证明真实模型推理、麦克风语音交互、打包桌面 UI 或 Windows 实机行为。这些必须分别记录。详见[验收清单](../../verification/build-computer-use.md)；源码修改和单测通过不是发布记录。
