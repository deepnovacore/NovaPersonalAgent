# Space / Host / Client 全量实施计划与进度

本轮用户明确要求持续实施 M0–M7，不在模块边界停止；审查问题持续修复，三轮以上仍不能收敛才报告无法收敛。沿用 handoff 的 D1–D25，用户授权当前云工作树及 `/workspace` 隔离构建目录。本文件是持续更新的执行账本。

## 工程决策

- 当前 `v1.1.0dev` 云检出原地继续，保留已完成投递内核。删除旧机制前使用 `backup/pre-space-host-client-5652030e` 保留基线；真实外部推送尚未执行；iOS 远端 CI 的验收分支推送等待用户确认。
- E2E 使用成熟 JOSE 库的标准 JWE，不自造加密原语；所有线上网络入口必须认证、验签、限额。密码学外部评审仍独立于代码审查。
- 业务协议 v1：Host 为唯一写入方。客户端意图持久化，op_id 幂等，冲突保留；聊天短时即时提交且不离线排队；stream 仅预览，最终回复持久化。
- O11 选 Host 快照恢复；Host 离线只能显示旧缓存。O3 保留既有 Host 的 latest/catchup 行为并公开标注，手机不接管。O8 同仓独立 relay / gateway 包。O10 手机通知用通知适配器。O12 通用中英文文案，不含私人内容。
- 一个安装多个 Space，各自目录/凭据/缓存；模式不可原地切换，切换必须新建 Space。独立模式不接入 relay，Client 模式不创建本地 runtime。

## 任务与所有权

| 任务 | 负责范围 | 状态 |
|---|---|---|
| A 认证、密钥、配对与标准 wire | relay/src/security*、pairing*、crypto*、wire 文档与测试 | 已接入并通过本轮自动化验收 |
| B 网络与自托管 | relay/src/server*、client*、cli*、Docker、网络测试 | 已接入并通过本轮自动化验收 |
| C Host | runtime/src/space-host/、Life/聊天/通知生产接线与测试 | 已接入并通过本轮自动化验收 |
| D Flutter | lib/space/、Space 创建/切换、Client 缓存/意图/聊天/工具、运行入口门禁 | 已接入并通过本轮自动化验收 |
| E 推送 | gateway 包、APNs/FCM/小米适配器，iOS NSE/Android 服务与配置 | 已接入并通过本轮自动化验收 |
| F 联验与清理 | 主线程：协议对齐、SDK、废弃 authority/handoff、文档、集成测试 | 已接入并通过本轮自动化验收 |
| G 独立审查 | 全新上下文审查上述任务与全分支，修复后复验 | 四轮独立审查问题已收敛 |

## 验证要求

各任务先测试再实现，报告真实失败/通过。主线程运行 relay/gateway/runtime/Flutter 测试与类型分析；跨端 schema/crypto fixture 共用。不得用假 transport 代替真实网络联验，不得用源码检查代替真机推送到达证据。M0/M6 真机账号证书缺口记录为外部验收依赖，继续完成可实现代码。

## 账本

- 前批投递内核：33/33 测试、19/19 既有回归、类型检查通过；一轮 fresh review 修复空页恢复 ACK 缺陷。
- 本轮开始：核实已有工作树，保留前批结果，不重复实施。


## 本轮集成记录

- Relay 已实现真实 HTTP/WebSocket、签名认证、标准 JOSE、扫码密钥分发、撤销轮换、限速/有界队列和按字节分页；Docker 非 root 实际启动及 signed create/login/mailbox/ACK/WS smoke 已通过。单条合法大信封与约 2.9 MiB backlog 分页回归已通过。
- Host 已接入生产 PersonalAgentHost/LifeService/MemoryLedger；展示快照、持久意图回执/冲突/临时 ID、模型聊天/取消、手机动作、通知与 source.input 共用现有权威服务。桌面提供配对/撤销面板，CLI 提供 init/resume。
- Flutter 已接入创建/切换 Space、Client 展示/离线队列/聊天/工具/推送，多 Space 持久目录和 secure keys 隔离。原生独立运行时也按 Space 隔离；iOS 单 iSH 内核已启动后换 Space 需完全退出重开，跨 Space 访问拒绝并提示恢复方法。
- 独立 push gateway、Host 通知 JWE、APNs NSE、FCM 和可配置官方小米 SDK 接线已实现。gateway 13 项、真实本地 HTTP Host→gateway 联验与 JVM 生产解密核心互通通过。没有真实厂商调用或真机到达证据。
- M4 真实 HTTP/WS Host 测试通过后执行 M7 删除：TS Hub/Life 双写、authority/handoff、Flutter 旧 Hub 链路及桌面 Tailscale/Hub 入口。保留普通 ScheduleService claim/bind/finish 和任务 effect fence。
- 桌面全量测试：1482 项，1442 通过、40 既有跳过、0 失败。Android arm64 Linux 运行组件构建通过，完整 APK 编译和原生测试已通过。

### 审查与修复追踪

1. 第一轮集成审查（`work/integration-review1.md`）：快照 revision 重启回退、聊天 preview/重复/拒绝状态、过大 mailbox response、聊天推送缺失、缓存无 GC、push 注册崩溃窗口、多 Space 通知跳转，以及两个关联目标 UI 缺口。对应实现已修，真实网络复验通过。
2. 第二轮独立安全审查（`work/crypto-review2.md`）：撤销响应丢失造成 epoch 分裂、被撤销设备历史信封阻塞、配对恢复错误码不匹配。采用持久管理事务/操作 ID、历史公钥验签后跳过旧 epoch、正确错误契约；另补首次创建与配对确认断网恢复。
3. 全新上下文设计完整性审查（`work/completion-audit.md`）：补 Client 手机采集入口和签名双向版本协商。二次产品审查及后续推送并发复审已收敛。

所有数量是对应时间点实际结果，最终整体验证另记录；不能用上述模块测试替代 M0/M5/M6 真机退出证据。新测试命令 `npm run test:space -- --output-root ... --run-id ...` 已加入 CI；部署顺序见 `docs/zh-CN/space-host-client.md`。


## 最终集成验收（2026-10-23）

- 隔离整栈 TypeScript 构建、runtime 全量 ESLint 通过。Space 测试 **98/98**，另真实 HTTP Client→Host→gateway→provider boundary 联验通过。
- 受影响的既有模型接入、provider session、MemoryLedger worker、mem0 回归 **57/57**。隔离构建脚本现保留各 workspace 本地安装的依赖解析。
- Flutter `dart analyze lib test` 无问题；14 个相关测试文件 **52/52**。
- 完整 Android debug APK 已构建（含 MainActivity、FCM、JNI 与实际 Linux runtime），原生 **65/65**。最终 APK 与源码逐文件比对一致；SHA-256 `0e608b81d6242dfb98da4ca51e7e026978de710e4eea131b999879eca0bcc1c2`。
- 使用环境配置 key 的真实 DashScope 模型联验通过：Host 持有模型调用，Client 收到预览后断线、重连补最终回复，重复意图只调用模型一次。详见 `2026-10-23-space-host-live-evidence.md`。
- 第四轮全新上下文推送复审确认共享写入、关闭 tombstone、持久 key inbox、锁顺序、body deadline、重启重试均收敛，无未解决的确定 P1/P2。
- 早期完整 runtime 测试 4405 项中 19 项失败已归因：10 项修复/环境依赖校正后通过，2 项旧 Space 编译结果由当前整栈测试覆盖；另 7 项在备份基线复现（6 个 POSIX/ACP 进程回收、1 个 Qwen 1.5 秒时限），没有通过修改生产逻辑掩盖。
- 公开增量审计无真实凭据、内部组织端点、私人数据、未审 IP 资产或生成二进制。起点 HEAD 与公开 origin/v1.1.0dev 相同；备份分支不推送。

### 未取得的外部证据

这不是 M0–M7 所有退出证据完成声明。iOS 完整 Runner+NSE 的 unsigned Xcode 构建已准备 workflow，尚需用户允许推送验收分支后在 GitHub macOS runner 实跑。真实手机杀 App 与 SDK 网络断开不是同一验收；iPhone/GMS Android/小米锁屏、隔夜、Doze、force-stop、NSE Keychain、点击补拉仍需真机及厂商账号。独立外部密码学评审亦没有以 agent code review 替代。上述项目不得标记为通过。
