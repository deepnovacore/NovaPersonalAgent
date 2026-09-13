# 外部精简复审意见核验与处理

核验基线：`8783f7cf`。逐项检查用户提供的外部复审意见；延续此前“确认的问题先修复、本地合入 v0.2.0dev”的授权。没有引入依赖，不改已批准的产品退役范围。

## 三项 P2

| 意见 | 核验结论 | 处理 |
|---|---|---|
| retired env 由报错变为忽略 | `REALTIME_PROVIDER`、`VOLCENGINE_ARK_MODEL` 等已删除条目确实被忽略；但 `MEMORY_BACKEND` 不属于这些 owner，`config.ts` 仍显式拒绝，原有测试仍覆盖它。实跑前两个变量与默认配置相等，后一个抛出含 `MEMORY_CONNECTION` 的迁移提示。 | 保留批 1 明确批准的删除，不恢复整个 retired 机制；在执行记录补充实际语义。 |
| R1 机器边界收窄 | 静态规则确实由所有具体执行器包收窄到 Codex；批 1 计划和当前 spec 07 也已同步写成 Codex，因此不是代码违反现行文档，但丢掉了原来更通用的约束。 | 恢复所有具体包的静态与字面量动态 import 限制，保留 `coding/` 角色协调器、registry 和精确的 `codex/host.js` 组合根例外。新虚拟包与原有 Codex 都有负向测试。 |
| local embedding 阻断整个桌面 | 属实。启动时校验失败，错误弹窗给出设置文件路径（含 recovery 提醒），随后退出；合法设置是 `publicSettings/readSecret/secretsPresent` 的前提。 | 保留已批准的“明确拒绝，不静默切云端”。未实现的 local 从来不是可用引擎；允许设置修复窗口独立启动可作为后续体验改进，不能通过默认为 DashScope 来实现。 |

## P3 逐项处理

| 意见 | 核验与处理 |
|---|---|
| `createFileAt` 忽略 exclusive | 参数目前不影响 Node authority 的原子创建：已有文件返回 `exists`，调用方决定是否允许它。锁调用方随后校验打开文件的类型、权限和路径身份，并在拿锁后再次核验。没有确认丢失正确性或数据；可后续收敛接口，不因此恢复重复文件操作逻辑。 |
| `persistentHome()` 不可达 | **不成立，不删除。** 外部会话守卫只适用于有 `executor_home` 且 origin 非 nova 的会话；旧 Nova 会话可能没有该字段。现有 `legacy sessions retain their private HOME...` 测试在已配置 shared HOME 时仍走旧目录恢复，并验证缺失 HOME 不会重建。删掉会破坏历史会话恢复。 |
| `input_*` 转发不可达 | 属实。字符串解析器不产生这三种内部 command，统一输入已在 `receiveControl` 前置处理。删除冗余分支和内部 kind，收窄后续转换函数的输入类型。现有 dictation/text 测试继续验证真实路径。 |
| service 纯转发成员 | 有实际调用者，不是死代码。删除需重新定义 facade 与 owner 的访问契约；本轮保留，不按 getter 数量机械改造。 |
| renderer graphBoard 桩 | 删除。 |
| knowledge adapter 用例名仍称 SDK client | 改为直接调用注入的 backend，与真实行为一致。 |
| sensitivity 计划路径 | 跟踪的 09-13 计划统一为 `runtime/src/memory/sensitivity.ts`；主工作区未跟踪的 09-12 用户文档不修改。 |
| staging 丢失 runtime/eval | **已复现并修复。** 原过滤器仅保留 `dist/src`，使随包 CLI 的静态 eval import 无法解析。补齐 `dist/eval`；回归测试真正运行 staging 后的 CLI，旧代码出现 `ERR_MODULE_NOT_FOUND`，修复后正常输出。 |

## 结构与残余风险

- `core/` 与 `realtime/` 双向依赖是既有结构，目录重组不等于架构分层。若将来要把 core 定义为底层，再围绕实际 owner/端口拆依赖；本轮不为目录名称引入新抽象。
- shared HOME 的深合并依赖真实 Codex 行为，不能靠自己模拟一个 merge 函数来证明。已用安装的 Codex 0.154.0、空临时 HOME、真实 `config/read` 再次离线核验：managed 保持启用，带点的外部条目禁用，磁盘配置字节不变；没有启动模型轮次或使用用户凭据。
- 仓内另补有效配置的离线断言：允许已禁用的外部条目，但 managed 丢失、被禁用、工具列表改变以及外部条目启用均被拒绝。这证明失败时的拒绝行为，不能替代每个 Codex 版本的 CLI 语义验收；没有新增固定版本准入限制。
- `source-startup-smoke.mjs` 当前仅在 Windows 运行；macOS 的 skipped 是平台分支，不是漏开环境开关。此前未重跑合并后打包的陈述属实，本轮补验 macOS 当前树。

## 验证

R1 与 staging 回归先观察失败，再修复；定向共 9 项通过。`npm run check` 通过。

首轮全量有 4 个异常超时，耗时均约 169–171 秒；系统日志记录同一期间 06:51:24 至 06:54:15 的合盖休眠。没有修改这些实现、测试断言或超时阈值。一次受影响用例的沙箱复跑遇到本机监听 EPERM，最终全量使用允许回环监听的环境重跑；仅在验证进程存活期间申请防空闲休眠。

最终验证已通过：

| 验证 | 结果 |
|---|---|
| Runtime 全量 | 2338 通过，8 条件跳过，0 失败 |
| Desktop 全量 | 881 通过，3 条件跳过，0 失败 |
| CLI 全量 | 21 通过，0 失败 |
| macOS arm64 app | 未签名打包通过 |
| 安装副本 | ASAR/native placement 与真实后端握手通过 |
| 实际 staging CLI | 静态依赖完整，`--help` 到达现有 usage 分支（按该 CLI 契约返回 2）；app.asar 含 eval JavaScript |
| Codex 0.154.0 | 真实离线 config/read 深合并探测通过 |

本轮没有重跑 Windows/Linux 安装包、真人语音或真实模型取消回收验收；没有签名、公证、推送或发布。日志目录：`/tmp/nova-review-feedback-20260914/`，最终日志为 `check.log`、`test-final.log`、`package.log`、`verify.log` 与 `codex-merge-probe.log`。

修复在原精简 worktree 内完成，随后本地快进 `v0.2.0dev`。既有未跟踪的 09-12 计划文档原样保留。

## 修复后规模

沿用 09-13 复审报告的源码物理行口径，生产 **91,778**，随包评测 **1,920**，测试 **100,447**，工具脚本 **7,362**，合计 **201,507 行**。相对 `8783f7cf`：生产 −9，测试 +46，脚本 −1，总代码 +36 行；未用删除测试换取减量。
