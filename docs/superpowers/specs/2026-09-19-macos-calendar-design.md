# macOS 本地 Calendar 接入设计补充

状态：已批准；用户已授权实现与 live 验收，2026-09-20 明确批准完整日历访问用于只读验收。此文将新增平台边界写实。继承 Composio connectors 设计的 source current、generation、处理同意、批次通知、暂停/断开/删除语义。

## 目的与范围

让 Nova 定期读取 macOS Calendar 可见的日历和日程，形成可追溯的本地来源证据；不需要 Composio 或开发者 API key。用户选择日历与时间窗口后开始同步。系统 Calendar 内同步的 iCloud/Google/Exchange 日历均按 EventKit 返回的来源展示；本地接入不等于上游日历数据从未经过云服务。

这里的“日程”指 Calendar events，不隐含 Reminders。首版不创建、修改或删除用户日程，不发邀请。按需工具查询和本地 Mail 是独立后续范围。

## 原生边界

使用 Apple EventKit 与仓库现有 Swift 编译、打包、签名及 native-resource manifest 通路。新增独立只读日历 helper，不向语音 helper 混入日历职责。桌面只接受清单验证通过的固定 helper 路径，以 shell:false 启动；runtime/model 不接受任意二进制或 shell 字符串。

helper 的 JSON 请求仅包含 status、request_access、list_calendars、snapshot 四种命令；snapshot 接受已批准的日历 ID 和有界起止时间。请求最多 64 KiB、响应最多 2 MiB、每轮最多 200 个事件、30 秒；取消或超限终止读取并返回 incomplete，不把部分集合当成完整空集合。实现阶段验证 EventKit 枚举的内存/回调行为；禁止先无界复制全部 events 再截断。

macOS 14+ 读取 events 需要 full access；系统没有满足该用途的只读授权。授权文案如实说明系统权限能力，helper 不实现任何写方法。Info.plist 包含 NSCalendarsFullAccessUsageDescription；旧系统兼容路径仅在实际构建目标需要时实现。TCC 归属、签名和 helper bundle 元数据必须用安装形态实测，不能把终端 Swift 脚本获权算作 Nova 获权。

## 同步与身份

复用现有 provider 无关 source state，不另建日历数据库。provider 标识为 macos_calendar，连接绑定当前机器和系统用户；以日历 ID 和事件本地标识、重复实例 occurrenceDate 组成对象键。跨账户迁移/重新同步导致系统标识变化时做完整核对，不能声称本地 ID 永久稳定。重复实例和全天日期/时区保留原语义，展示不得把全天 UTC 转换成前一天。

EventKit 无服务端 syncToken。本版明确标为窗口快照核对：过去 30 天至未来 90 天为默认窗口，定时与唤醒触发；变更通知只作提前重新读取的提示，不能单凭通知宣告同步完成。完整窗口读取成功才可将本次未见对象标为 coverage_removed；权限拒绝、helper 崩溃、预算耗尽、日历不可见均不能直接宣布 provider_deleted。窗口滑动与原始删除分开显示。

语义哈希覆盖标题、正文、开始/结束、全天、取消状态等会影响记忆的字段；日历颜色、读取时间等展示元数据变化不重抽取。快照分批通过 applySourcePage 及现有 fence 写入。范围改变、暂停、撤销权限后旧 helper 响应必须被拒绝；断开不调用 delete_source，删除前先 bump generation。

系统读取许可与模型处理同意分开。默认只本地保存，不调用抽取/embedding；用户明确同意并绑定 provider fingerprint 后才走共享处理通路。

## 设置与验收

在已有来源设置中展示“本机日历”、授权状态、日历选择、窗口、处理同意、最近完整核对与 incomplete 原因。非 macOS 显示不支持，不探测其他平台私有文件；不得直接读取 ~/Library/Calendars 数据库绕过 TCC。

验收分三层记录：Swift/Node 协议和快照差异测试；打包后 helper 清单/签名/权限归属；本机真实日历列表与至少一条现有日程和 Calendar UI 对照。重复/全天/取消/撤权没有真实样本时标未测，不以空日历通过代替。需要新增或修改真实测试日程时另行取得具体写操作授权。

## 官方依据

- [Apple EventKit 权限迁移](https://developer.apple.com/documentation/technotes/tn3152-migrating-to-the-latest-calendar-access-levels)
- [requestFullAccessToEvents](https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoevents(completion:))
- [Event store](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)
