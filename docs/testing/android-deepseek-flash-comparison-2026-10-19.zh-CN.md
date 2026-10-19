# Android DeepSeek Flash 原生任务对照

日期：2026-10-19。分支：`fix/android-mobile-auto-steps`。模型兼容实现：`7ec0b266`。

## 结论

在小米 14 / Android 14 上交替执行“打开小红书，搜索今日OOTD”，DeepSeek Flash 成功轮次平均 15.12 秒，Qwen3-VL-Plus 平均 25.31 秒，前者成功轮次耗时约少 40%。DeepSeek 两次成功均直接选择已有搜索历史，动作数为 2；Qwen 输入关键词再提交，为 3–4 步。因此差异包含操作路径收益，不能解释成纯模型推理快 40%。

DeepSeek 三轮完成两轮；另一次在第一个点击前因截图期间画面变化而暂停。Qwen 三轮均完成。样本很少，不能据此确定长期成功率，也未证明 DeepSeek 更稳定。测试后已恢复手机原有 Qwen 配置，保留 DeepSeek 兼容支持。

用户明确取消了采样间隔实验；截图及动作后观察间隔始终保持 500ms。

## 方法

- 同一个正常版 Nova APK、相同设备、网络、原生截图与工具回路、相同任务和验收文本。通过 Flutter 调试连接调用正式 `NativeLocalAgent`；没有重新安装独立测试包。
- 两个模型各执行三轮，交替测试。每轮开始前仅 force-stop 小红书并把 Nova 带到前台；任务由 Nova 自己启动小红书。保留搜索历史与用户资料，不清数据。
- 计时从调用原生 `run` 到轮询发现 `verifying` 或 `interrupted`，包含模型请求、截图、原生动作和 App 加载，不含之后截图取证。轮询有少量观测误差；本轮不含旧验收脚本的两秒重放检查。
- 所有操作由真实模型提出、原生控制器执行，脚本不替模型搜索或输入、不调用逐步审批，也不伪造用户最终核验。成功轮次均独立查看截图，确认关键词及结果列表；模型宣称完成不单独作为通过依据。
- 第一轮准备被 MIUI 的 Nova 打开小红书权限询问拦住，0 个动作，未进入有效对照，记录仍保留为 `deepseek-flash-cold-1`。权限处理后才开始下表六轮。

| 顺序 | 模型 | 用时 | 动作数 | 独立核对 |
| --- | --- | ---: | ---: | --- |
| 1 | deepseek-flash，关闭思考 | 15.253 秒 | 2 | 结果列表正确 |
| 2 | qwen3-vl-plus | 27.288 秒 | 4 | 结果列表正确 |
| 3 | deepseek-flash，关闭思考 | 5.311 秒 | 0 | 未完成：`tool_screen_changed_during_capture` |
| 4 | qwen3-vl-plus | 24.018 秒 | 3 | 结果列表正确 |
| 5 | deepseek-flash，关闭思考 | 14.990 秒 | 2 | 结果列表正确 |
| 6 | qwen3-vl-plus | 24.613 秒 | 3 | 结果列表正确 |

失败轮次不纳入成功耗时平均数，也不算成提速。截图变化错误来自点击前的本机画面校验；没有证据将其直接归因为模型识别错误。本轮未修改这一执行边界。

## 接口兼容与验证

官方当前 `deepseek-flash` 支持图片与工具调用，但默认思考模式会拒绝 Nova 的指定 `next_step` 工具调用，实测返回 HTTP 400：`Thinking mode does not support this tool_choice`。关闭思考后，同一图片加工具探测成功（简单探测 0.911 秒，不作为完整任务性能）。

适配仅在 Chat Completions、模型名精确为 `deepseek-flash`、端点主机精确为 `api.deepseek.com` 时添加 `thinking: {type: disabled}`。保留截图、指定工具和现有校验，其他提供商与协议不携带此参数。

新增回归先观察到失败，修复后 Android app JVM 54 项测试通过；正常 APK 构建成功，独立静态审查无 Critical / Important 问题。已安装候选包 SHA-256：`38a6ae729bbb2b42c13ac3a5082f116ea7db00f4abbb1390edf0c21070b989ae`。

参考：[模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[视觉输入](https://api-docs.deepseek.com/guides/vision)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)。

## 本地证据

保存在原自动执行验收相同的外置盘会话证据目录：

- `deepseek-manifest.json`：候选来源、哈希、六轮结果与恢复状态。
- `deepseek-probe.json`：默认模式的拒绝与关闭思考后的接口探测。
- `deepseek-flash-cold-{2,3,4}.json/png`、`qwen-vl-cold-{1,2,3}.json/png`：原生回执与画面。
- `deepseek-red.log`、`deepseek-green-build.log`、`deepseek-test-results/`：测试及构建证据。
- `nova-deepseek-flash-candidate.apk`：正常入口候选。

截图及原始任务内容不进入公开源码；凭据未写入报告。无推送或合并。
