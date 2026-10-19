# Android 原生任务自动执行验收

日期：2026-10-19。分支：`fix/android-mobile-auto-steps`。基线：`55f4685b`；自动授权实现：`cf0dabdf`；最终生产代码：`d7208fc4`。

## 行为与修复

用户启动任务后，所选 App 内的后续动作自动获得与当前画面绑定的一次性授权。Android 不再产生逐步审批弹框或 `waiting_approval` 状态。保留停止、目标包检查、画面变化检查、动作预算、密码框限制与持久化去重。最终完成声明仍等待用户核验；iOS 策略未改变。

实机发现并修复了停止浮层遮挡搜索按钮、动作派发前画面变化导致过早暂停、冷启动目标 App 尚未进入前台、截图限流、搜索结果加载期间立即暂停的问题。所有重试均有次数上限：只重新观察或在派发前重新规划，不重放已派发或结果不明的动作。新的 `observe` 决策用于短暂加载；`wait` 仍为需要用户介入而立即暂停。

## 自动化验证

- Android app JVM 单元测试 52 项通过，0 失败、0 跳过。覆盖自动授权、过期画面重新规划、冷启动等待、截图限流、加载重读、停止、预算与错误信息脱敏。
- Flutter 任务/原生接入测试 9 项通过；Flutter analyze 无问题。
- 新增关键回归已观察到修复前失败，修复后通过。
- 验收入口及正常 `lib/main.dart` 入口的 Android debug APK 均构建成功。
- 独立代码审查未发现剩余 Critical / Important 问题。

## 真机 live 结果

设备：小米 14，Android 14。模型：`qwen3-vl-plus`，DashScope OpenAI 兼容接口。用户手动开启无障碍并完成小红书登录。

| 最终候选用例 | 实测结果 |
| --- | --- |
| 小红书冷启动搜索“今日OOTD” | 通过。3 个真实动作：打开搜索、输入关键词、点击搜索；独立截图确认搜索词与相关笔记列表；约 31.94 秒 |
| 连续三步 | 通过。计数器由 0 到 3，恰好 3 次原生点击；约 18.23 秒 |
| 执行中停止 | 通过。首个动作后停止，计数器保持 1；停止回执后的 5 秒内无新增动作 |
| 请求重放 | 上述三项均通过；重复原请求未增加动作 |
| 逐步审批 | 三项均为 0 次；状态未进入 `waiting_approval` |

冷启动前仅通过 ADB force-stop 小红书作为准备；搜索与输入均由真实模型通过 Android 原生工具执行。热启动成功样本约 26.69 秒。以上任务时长含启动准备及约 2 秒重放检查，不是纯模型推理延迟或性能分位数。

验收通过 `integration_test/live_model_fixture.dart` 调用与正式入口相同的原生控制器、真实模型、截图与手势。脚本不调用 `approve`、不伪造模型回复、不替模型点击目标控件，也不把模型完成声明提升为用户确认。此轮未覆盖语音入口的整链路。

调试阶段曾出现模型坐标越界、模型错误宣称已完成、页面动态变化和加载失败；失败记录均保留，未计入通过。最终通过样本证明此设备与模型上的指定用例可用，不代表任意 App 或每次模型输出均能成功；无效坐标仍会被拒绝，最终结果仍需核验。

## 安装与清理

正常包 `com.nova.nova_mobile` 已通过 `install -r` 升级，未清数据；启动后既有会话仍可见。系统显示正常包的无障碍服务已绑定。重复的独立验收包 `com.nova.nova_mobile.autonomy` 已卸载；未移除其他不同用途的包。

## 候选与本地证据

外置盘证据根：`/Volumes/sqxh-junjie/DeveloperStorage/Builds/nova-0fa853cdd9ed/01a15348-59b6-7182-a9e8-bfd56c08e595/evidence/`。构建输出、SDK 和编译缓存按工作树与会话隔离。

- 最终验收 APK：`native-auto-final-candidate.apk`；SHA-256 `b3889ba99cec69b393bb6e7deb2d34b9d12a40324719561579a259274af410b8`。
- 最终正常 APK：`nova-android-auto-final.apk`；SHA-256 `fe19df9da04f92d55e6995d485b6948a3b4252e814eb10de1113adb63280d135`。
- 最终实机记录：`live-xiaohongshu-final.json`、`live-counter-final.json`、`live-stop-final.json` 及同名截图；正常启动截图 `normal-final-startup.png`。
- 构建日志：`throttle-green-build.log`、`final-main-build.log`；JUnit XML：`native-final-test-results/`；来源与摘要：`manifest.json`。
- `run.py`、`device.py`、`monitor.py` 位于证据根上一级。

原始设备截图、任务记录和 APK 仅保存在本地外置盘；无推送或合并。
