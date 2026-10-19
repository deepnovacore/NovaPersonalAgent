# Android 原生任务自动执行验收

日期：2026-10-19。分支：`fix/android-mobile-auto-steps`。实现提交：`cf0dabdf`，基线：`55f4685b`。

## 行为

用户启动任务后，所选 App 内的后续动作自动获得与当前画面绑定的一次性授权。Android 不再产生逐步审批弹框或 `waiting_approval` 状态。保留停止、目标包检查、画面变化检查、动作预算、密码框限制与持久化去重。最终完成声明仍等待用户核验；iOS 策略未改变。

## 已验证

- 红灯：新增 Flutter 启动文案断言捕获原有逐步确认说明；新增原生模型提示断言捕获原有每步审批指令（6 项中该项失败）。
- 绿灯：Android app JVM 单元测试 37 项通过，0 失败；Flutter 任务/原生接入测试 9 项通过；Flutter analyze 无问题。
- 验收入口与正常 `lib/main.dart` 入口的 Android debug APK 均构建成功。
- 独立代码审查未发现新的生产执行问题；已修正停止验收的基准取样窗口，并复核。
- 验收 APK 已通过 `install -r` 安装到小米 14（Android 14）的独立 `.autonomy` 包，保留既有资料。正常入口 APK 已构建，尚未安装。

## 真机 live 状态

**尚未完成：等待用户手动开启测试包的 Android 无障碍服务。** 当前系统返回 `enabled_accessibility_services=null`。未把安装成功或历史结果记成本次 live 通过。

待执行的真实模型用例：

| 用例 | 判定 | 状态 |
| --- | --- | --- |
| 连续三步 | 真实模型驱动计数器由 0 到 3，三次原生派发，无逐步审批 | 待执行 |
| 跨 App 计算器 | 真实模型操作系统计算器完成 17 × 23；独立核对画面为 391 | 待执行 |
| 执行中停止 | 第一动作后停止；从停止回执起无新增派发或计数变化 | 待执行 |
| 请求重放 | 重复同一任务请求只返回回执，不增加动作 | 随上述用例检查 |

验收入口为 `clients/flutter/integration_test/live_model_fixture.dart`；它不调用 `approve`，不伪造模型回复，不替模型点击目标控件。计算器用例的脚本结果仅证明循环与重放检查，仍需独立 UI 取证。测试不把模型完成声明冒充用户核验。

## 候选与本地证据

外置盘证据根：`/Volumes/sqxh-junjie/DeveloperStorage/Builds/nova-0fa853cdd9ed/01a15348-59b6-7182-a9e8-bfd56c08e595/evidence/`。构建输出、SDK 和编译缓存按工作树与会话隔离。

- 验收 APK：`native-auto-live.apk`；SHA-256 `7cc4cb41083c36e852ef71900b51db76a78dc671c5438e7216e7721081e76382`。
- 正常 APK：`nova-android-auto-debug.apk`；SHA-256 `83c8c9846a35619b4ca5524d491b874eb8ce4a75e6a6cc08fcc7d169d6a6021b`。
- 日志：`native-red.log`、`native-green-build.log`、`live-build.log`、`normal-build.log`、`flutter-tests.log`、`flutter-analyze.log`。
- `native-test-results/` 保存 JUnit XML；`manifest.json` 保存源码与候选信息。
- `run.py` 位于证据根的上一级，恢复时无需依赖临时目录中的脚本。

原始设备截图、任务记录和 APK 仅保存在本地外置盘；无推送或合并。
