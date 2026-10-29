# v1 core P1 fixes 分支评审

## 2026-10-28 最终集成结果

原 CORE-1 至 CORE-4 已关闭，Core 与 UI 已在独立外置盘 worktree 完成组合验证，并本地合入 `v1.0.0dev`，当前 HEAD 为 `ea0fd201`。没有推送；原两个 worktree 和分支均保留。

- `884d8947`：合并 Core `56748cc5`。
- `6cbe1190`：合并 UI `069daa6c`；解决唯一的 `workbench-runtime.ts` 冲突，同时保留 caption 撤回与思考记录。
- `ea0fd201`：另行提交用户授权的最小头像偏好缓存回滚修复及回归测试。

本轮实跑组合验证：`npm run check` 通过；runtime 4721 项（4705 通过、11 跳过、5 TODO、0 失败）；desktop 1660 项（1647 通过、13 跳过、0 失败）；Flutter 1007 通过、4 跳过，analyze 无问题；CLI 34/34、server-cli 4/4 通过。头像新增回归先复现 3 个失败，修复后定向 28/28 通过。

首轮 Node 测试曾因临时目录在仓库内而继承 ESM 设置，以及 Unix socket 路径过长失败；保留原日志，改用仓库外短路径后重跑全量通过。完整日志位于 `/Volumes/sqxh-junjie/nova-builds/review-merge-ec386f7dc50a-01a17d93/`，并非忽略失败用例后通过。

主工作区原有 9 个修改或未跟踪文件在快进合并前后均通过字节校验。本次随后只更新这两份 review 文档；其他原有改动保持不变，未纳入本轮测试。真机、真实模型调用、桌面打包和发布仍未执行。报告保持本地未跟踪状态，没有加入产品提交。

---

## 2026-10-28 修复复核（最新结论）

复核范围：`b2c73898..56748cc5`，4 个修复提交；已确认分支为 `fix/v1.0.0dev-core-p1`，HEAD 为 `56748cc5`，worktree 干净。

**结论：原 CORE-1 至 CORE-4 均可在源码复核层面关闭；本轮没有确认新的合入阻断问题。** 以下不代表测试由评审方重新运行，也不代表真机验收通过。

| 原项 | 状态 | 修复及回归用例复核 |
| --- | --- | --- |
| CORE-1 | 关闭（静态） | `3f0e3c09`：本地桌面在 workbench 中对选中的 completed / paused-stopped Build 主动提交新指令可重新授权。其他暂停原因仍受限制。读过重启新 host 后继续 completed Build 的用例，以及 Stop 后直接发指令的用例。后一个用例实际先完成再 Stop，并没有覆盖正在执行时点击 Stop 的全过程。 |
| CORE-2 | 关闭（静态） | `6e9ff61f`：open 超时会回收 worker，旧 worker 的迟到响应被 worker 身份检查隔离，重试在新 worker 中打开。新增用例推进 30 秒超时、检查 terminate 并重试打开；不再出现旧 worker 已打开而客户端拒绝承认的原问题。 |
| CORE-3 | 关闭（静态） | `53fd9df5`：ledger 自动重开失败后会继续调度，退避从 250 ms 翻倍、封顶 5 s，关闭 client 会取消定时器。新增用例覆盖首次重开失败、后续成功及业务读取。 |
| CORE-4 | 关闭（静态） | `56748cc5`：工具启用时 Ark 暂存权威文本，仅文字模式可发 preview；终态确认无工具才发 text_delta。有工具的响应不会先送可播放文本。新增用例覆盖带工具的文字/语音、无工具调用的最终回复和文字预览路径。 |

验证记录：修复方报告 `npm run check`、全量 runtime、desktop、119/119 CORE 定向套件通过，并说明曾出现一次 memory-file-authority 超时、随后单测与最终全量通过。本轮只读核查代码及新增测试设计，没有独立重跑这些命令，也没有核验运行日志；这些数字不能标作本轮实跑结果。

额外检查了授权失败路径及自动恢复边界。拒绝并发 Build 时可能留下内存授权的候选，尚未证实正常客户端可造成错误执行，未列正式缺陷。VoiceMem 的 open 超时状态错位已修复，但没有据此宣称所有自动重开失败场景都可恢复。

未检查：真实语音/模型调用、原生交互、完整测试与编译、两个分支合并后的行为。两份报告只更新文档，没有修改源代码、提交、合并或推送。

---

## 2026-10-27 初审记录（保留历史）

初审结论：在 `b2c73898` 上发现以下 4 项；当前状态以文首复核为准。下面的位置及推导针对初审快照。

## 范围与证据边界

- Worktree：`/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final`
- 分支：`fix/v1.0.0dev-core-p1`
- 目标：`b2c73898991e850e754c6b1a08fbe87b7bfc0d36`
- 比较基线 / merge-base：`6531ac71ff88fe0d047924b01d8710fdde3764c6`
- 范围：16 个提交、56 个文件；目标 worktree 评审前后均无未提交改动。
- 这批修改主要修复配置路由、Build 导航与语音所有权、状态恢复、记忆 worker 生命周期及执行器资源释放。
- 主评审与 `gpt-6.1-terra` 独立审查 diff、调用方、相关实现和测试源码。按单用户桌面宿主、后台记忆任务与前台会话并行的实际使用方式判断。
- 以下均为静态调用链确认；没有运行测试、构建、服务、真实模型调用或真机验收。没有修改目标代码，没有 commit、merge 或 push。

## 必须修复

### CORE-1 · P1：已完成的 Build 重启后无法继续输入新指令

**位置：** [host.ts:788](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/runtime/src/personal-agent/host.ts:788)。关联：同文件 `206`、`216`、`282–284`；[workbench-agent.mjs:98](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/clients/desktop/src/renderer/workbench-agent.mjs:98)、[chat-pane.mjs:252](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/clients/desktop/src/renderer/chat-pane.mjs:252)。

**功能与触发：** Build 处于 `completed` 时仍允许用户继续修改。完成一轮 Build，退出并重启宿主，回到这段 Build 输入新指令即可触发；点击 Stop 后直接发新指令也会触发。

**问题与证据：** 新增入口检查要求 `localBuildAuthorized(id)` 已成立，之后才到达恢复授权的 `#localBuildAuthority.add(id)`。授权集合只在内存里，重启即为空，Stop 也会删除授权。输入框仍允许 `completed` 会话发送，但请求被拒为 `local_build_not_authorized`。唯一能先恢复授权的 `build.resume` 按钮又对 `completed` 隐藏，因而该会话没有正常的 UI 继续入口。

**最小修复：** 区分“已运行 Build 的持续授权”和“用户主动发起的新一轮”。本地桌面在 workbench 中、选中该会话并明确提交新文字时，经原有安全条件校验后重新授权；保留后台运行所需授权。补充 Stop 后发新指令、重启后继续 completed Build 的回归用例。

**不修复的影响：** 用户看到可输入的旧 Build，却无法继续工作；paused 状态下还必须先 Resume 旧任务，才能重新发自己的新要求。现有 `workbench-runtime.test.ts` 同进程 completed 续轮场景没有覆盖授权集合重置。

### CORE-2 · P2：VoiceMem 首次打开超时后，迟到成功会让客户端与 worker 永久不同步

**位置：** [store-client.ts:226](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/runtime/src/voicemem/store-client.ts:226)、同文件 `233–235`、`354–358`、`387`；[store-worker.ts:113](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/runtime/src/voicemem/store-worker.ts:113)。

**功能与触发：** 客户端现在把慢请求超时限定为单次请求失败，保留 worker。冷启动时数据库打开耗时超过 `OPEN_TIMEOUT_MS = 30_000`，随后 worker 成功返回即可触发。

**问题与证据：** 打开请求超时后，request ID 被加入 `#dropped`，`#opened` 仍为 false，`#opening` 被清空；迟到成功响应在 `#handleMessage` 中直接丢弃。worker 已经打开数据库，但后续 `open()` 重发会得到 `STORE_ALREADY_OPEN`，所有 recall / entry 请求又被客户端的 `#opened` 检查拒为 `STORE_CLOSED`。

**最小修复：** 把 open 超时与普通读请求超时分开处理：超时后回收并重建 worker，或者保留打开状态机并正确接收迟到的 open 成功。增加“open 超时 → 迟到成功 → 再次 open / recall”用例。

**不修复的影响：** 一次慢启动使该客户端在本进程内无法恢复；增加普通请求重试不能解决双方打开状态不一致。

### CORE-3 · P2：ledger 自动重开只尝试一次，临时失败后实际调用链不会再重试打开

**位置：** [store-client.ts:303](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/runtime/src/memory-ledger/store-client.ts:303)。关联：同文件 `155–167`；[resource.ts:151](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/runtime/src/memory-substrate/resource.ts:151)。

**功能与触发：** worker 退出或同步操作卡死后会替换 worker，并在 250 ms 后自动 `open()`。该次打开遇到短暂文件锁或文件同步冲突，失败后外部条件恢复即可触发。

**问题与证据：** 定时器只调用一次 `this.open().catch(...)`，失败被吞掉，并假设“下一个调用者重试 open”。生产路径的 `memory()` 直接提交业务请求，不会调用 open；上层 resource 的 `#opened` 没有随 worker 重建复位，再次调用 resource.open() 也直接返回。后续读取及每分钟维护都不能重新打开数据库。

**最小修复：** 让 worker 就绪状态成为业务请求的前置条件，在需要时触发/等待共享的 open promise；或者在关闭前有界退避重试自动打开。增加“worker 重建 → 首次 open 失败 → 条件恢复 → 普通 memory 调用成功”的集成用例。

**不修复的影响：** 本来短暂的文件争用变成整个进程持续的记忆不可用。仅测试重建后立即打开成功，不能覆盖此路径。

### CORE-4 · P2：混合文本/工具修复仍可能先播出随后被撤回的旁白

**位置：** [adapter.ts:1154](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/runtime/src/realtime/cascaded/adapter.ts:1154)。关联：同文件 `1114–1146`；[ark-llm.ts:195](/Volumes/sqxh-junjie/nova-worktrees/v1-core-p1-fixes-20261027-final/runtime/src/realtime/cascaded/ark-llm.ts:195)、`218–222`。

**功能与触发：** 本次修复允许 Ark / Responses 在同一响应里先返回文本、后返回工具调用，并尝试撤回前面的旁白。语音模式下先返回一个可成句的 text delta，间隔足够让 TTS 合成播放，再结束工具响应即可触发。

**问题与证据：** Ark session 立即转发 `text_delta`，工具却等 `response_completed` 后才发给 adapter。adapter 收到文字便创建 TTS、按句发送语音；收到工具时再 `#cancelTts()` 和清空字幕。已经播放的声音无法撤回。这里修复了混合响应失败，但没有实现注释所称的“display-only”旁白边界；这是本次修复未闭环的问题，不能称为新增的首次发声回归。

**最小修复：** 工具启用时在 Ark / Responses provider 层暂存文本，只发可撤回 preview；终态确认无工具后才发权威 `text_delta` 给 TTS。沿用 Chat Completions 已有的对应处理方式。

**不修复的影响：** 用户听见的工具前旁白可能随后从字幕及历史消失，尤其工具尚未完成时的成功宣称无法收回。补充先文本、延迟工具响应的 fake TTS 断言：工具前不提交可播放文本；本次没有录音实测，实际听见与否取决于流式时序。

## 结论与未检查项

初审建议先修复 CORE-1 至 CORE-4；最新关闭状态见文首。没有把未经确认的 WAL 物理清理并发候选列为正式问题，也没有把旧评审清单当成本分支现存缺陷重复抄入。

未检查：完整测试、编译、原生 UI、真实语音/模型行为、跨平台文件锁、两个分支合并后的组合行为，以及完整公开历史/资产发布审计。本报告不构成发布或真机验收结论。
