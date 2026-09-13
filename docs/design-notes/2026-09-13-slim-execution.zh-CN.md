# 精简执行记录

目标分支 `plan/slim-2026-09-13`。主工作区未改；未合并、推送或发布。十批已逐项实施、审查和核验；原审计中不能等价删除的条目保留实际保障，原因单独列明。

| 批次 | 当前状态 | 证据与边界 |
|---|---|---|
| 1 | 完成并集成 | 旧审计退役、ESLint 静态与动态导入边界、eval 移出 src、旧脚本与死 executor 删除；级联 oracle 的有效断言迁移保留。最后审查无遗留项。 |
| 2 | 完成并集成 | WebUI 及隐藏备份从当前树删除，备份分支不动；运行时 2577 通过/8 跳过，桌面 1028 通过/3 跳过。 |
| 3 | 完成并集成 | 图功能退役，sensitivity 保留，当前规范同步；真实 Chrome 进度界面在三个缩放等级通过。全量运行时仅发现固定提示词快照遗漏一条图说明，精确同步后协议 14 项通过；桌面 1020 通过/3 跳过。 |
| 4 | 完成并集成 | 发布检查收敛到 250 行 verifier，保留实际依赖 staging、原生资源 manifest 和签名路径；真实 macOS 未签名安装副本的后端握手通过。集成桌面 878 通过/3 跳过。签名发布未执行。 |
| 5 | 完成并集成 | Node 文件系统替代原生文件操作；Windows 实际 MSVC 编译、目录刷盘、锁竞争和进程退出后释放、Node 路径身份测试通过。Claude 最终复审 PASS；集成 check、运行时 2327 通过/8 跳过、桌面 878 通过/3 跳过。 |
| 6 | 完成并集成 | 四个实际 owner 已迁出，service.ts 1800 行；各阶段 Claude PASS、361 项回归通过。构造期 intake dispatch 的 await 顺序按复审恢复，相关 329 项复验通过。 |
| 7 | 完成并集成 | 共享 HOME、Nova/external 归属、旧私有 HOME 原位兼容、无磁盘凭据覆盖；Claude 关键复审 PASS。集成 runtime 2326 通过/8 跳过、desktop 878 通过/3 跳过。真实 Windows HOME/env 14 通过/3 POSIX 专属跳过；真实 Codex 0.154.0 的隔离假认证文件/进程 key 探针通过，不冒充真实账户登录验收。 |
| 8 | 完成并集成 | 桌面传输/assembly、设置/lifecycle、审批、存储 schema、知识库直调、deadline race 各组通过审查。集成 check、runtime 2328 通过/8 跳过、desktop 874 通过/3 跳过。知识库 RRF 新旧 12 组差分一致；存储解码 326 组差分一致。下列误判前提按真实行为修正。 |
| 9 | 完成并集成 | service 五组 owner 测试+共享 harness 保留 282 个静态测试调用/1036 个断言；存储 harness 保留 85/369；Codex 表展开后保持3个名称/10组预期，四个 mock 测试准确改名。Sol 审查 PASS，集成 check 与 419 项定向回归通过。 |
| 10 | 完成并集成 | 73 个模块按职责迁移，根层 TS 从基线 85 个降至 5 个公开入口。2603 条导入边、3 组原有依赖环、公开导出、4 对 worker 邻接关系一致；180 个生产文件 AST 主体一致。全量测试与 macOS 安装副本终验通过。 |

## 实测修正的计划前提

- 原级联 oracle 在当前基线实际通过；迁移有效断言后才删除，不能依据旧审计的失败描述直接退役。
- Windows `taskkill` 无法在 leader 已退出后清理脱离的后代。保留最小 Job Object guardian；sandbox C probe 是真实生产准入消费者，同样保留。
- 用 `O_EXCL` 或 mkdir 锁不能同时保证多进程崩溃恢复与无竞争接管；保留最小 flock/LockFileEx，不 unlink 锁文件。
- Node Windows 只读目录 fd 无法 fsync。保留极小 native flush：获取 fd 最终路径，以 FILE_ADD_FILE 打开，核对 volume/file identity 后 NtFlushBuffersFileEx，所有临时 handle 关闭。实机通过，失败保持失败。
- Node 路径操作的单用户目录替换竞态上限已在代码说明；不伪造原生相对句柄保证。
- 批 4 旧 build/sign hooks 直接依赖被删脚本，因此同步改接精简后的实际 staging/manifest。签名能力保留不代表完成真实签名发布验收。
- 两处既有测试 fixture 已修复：认证 helper 必须消费 ready 后任务快照；renderer mock 必须提供 microphone.onToggle。生产语义未为测试改变。

- 存储事务锁不验证磁盘 JSON：保留严格字段 schema 与跨记录不变量，改用已有 Zod；326 组新旧结果一致。目录替换原本只有一个 mutation owner，journal 的 prepared/committed 恢复不能合并成裸 rename。
- confirmed capability 的 admitting/retry/revoke 是真实并发授权边界，保留。Codex 审批模块中的真实参数解析保留，删除的是别名与继承透传。
- 当前 Codex 版本准入是 >=0.145.0，schema 证据是 0.152.0，桌面 bundle 另有版本；不存在可直接复用的精确认证 pin。保留实际协议准入校验与实时输入验证，不能用只走 initialize/thread 的一次 smoke 冒充所有审批/turn 方法的认证。
- 公共 deadline race 只复用等待/取消监听；adapter 的晚到写入结果与清理宽限、RPC 的主动中止、transport 的被动等待仍由原 owner 处理。

最终计量按生产、测试、脚本、文档和审计/历史备份分别统计；文件移动和 import 改写不算净删除收益。

## 最终验收

代码终验提交 `8e379307`（目录迁移 `d4ee6858`）；其后仅更新本文与计划状态。全部变更在指定 worktree 内提交，主工作区的既有未跟踪文档未改动。

| 检查 | 结果 |
|---|---|
| check | 类型、ESLint、环境契约、wire 与 capability 漂移检查通过 |
| runtime 全量 | 2328 通过，8 跳过，0 失败 |
| desktop 全量 | 874 通过，3 跳过，0 失败 |
| CLI 全量 | 21 通过，0 失败 |
| 最终 Windows HOME/env | 实机 Node 24.20.0：14 通过，3 个既有 POSIX chmod 专属跳过，0 失败；目录迁移后的依赖闭包也通过 |
| Windows 原生 | 实际 MSVC 编译、目录 flush、LockFileEx 竞争/崩溃释放、Node 文件身份通过；Job guardian 保留 |
| 真实 Codex 进程 | macOS Codex 0.154.0、生产 POSIX process owner、隔离临时 HOME 和本地假模型端点：任务启动、实际 responses 请求、turn/interrupt、ps 与进程组消失检查通过；Node/Codex/git 后代全部回收 |
| 认证隔离 | 合成认证文件与假 key 实测 `/v1/responses` 使用进程 key，原 auth.json 字节不变；不代表真实账户登录或模型质量验收 |
| 真实 Chrome renderer | 1/1.25/1.5 三档缩放，进度/审批/过期/重连/设置场景通过，无 pageerror；1.5 倍截图人工检查无裁切 |
| macOS 包 | 未签名 arm64 app 构建通过；ASAR/native placement 与独立安装副本的实际后端握手通过 |

终验发现并处理的两项问题：ESLint 内存测试片段使用旧相对路径，改为新 composition 路径，未放宽规则；安装副本复制遇到 ENOSPC，只清理本次任务旧分支的未跟踪 build/dist 产物后复验通过。未删除用户项目、HOME、认证或数据库。桌面测试中的默认 source-startup smoke 未启用，真实安装副本握手单独执行。

未执行签名/公证、Windows/Linux 安装包验收、远程 CI、合并、推送或发布；不把这些状态写成已完成。

## 实际减量

对比基线 `62520e20` 与代码终验提交，按 Git 跟踪的非二进制文本物理行统计。生产目录为 runtime/src、desktop src/native、iOS、WebUI、CLI src；测试、脚本/工作流、fixture、审计/备份与文档分开。文件移动、路径改写不算净删除。

| 类别 | 基线行数 | 完成后行数 | 净减少 |
|---|---:|---:|---:|
| 生产目录 | 109033 | 92306 | 16727 |
| 随包评测（从 src 迁出） | 0 | 1920 | -1920 |
| **生产与评测合计** | **109033** | **94226** | **14807（13.58%）** |
| 测试 | 118768 | 101113 | 17655 |
| 脚本与工作流 | 13952 | 7593 | 6359 |
| Fixture | 233261 | 227872 | 5389 |
| 审计与隐藏备份文件 | 6986 | 0 | 6986 |
| 配置及其他文本 | 9427 | 9323 | 104 |

文档截至代码终验提交净增 15 行；本文最终验收记录另计，不纳入源码收益。WebUI 恢复分支仍保留且未推送。原预算约 29k 生产减量没有实现为同等收益：原生锁/Job/sandbox、实际磁盘与协议验证、确认授权阶段均有真实消费者或正确性职责；结构拆分也不是删行。所有相关条目已按上述证据处理，不以删断言或删平台来凑预算。

详细原始日志与逐批审查保存在本机 `/tmp/nova-slim-execution/`：`runtime-final2.log`、`desktop-final.log`、`cli-final.log`、`package-verify-final2.log`、`windows-native-check6.log`、`windows-layout-run.log`、`codex-process-cancel.log`、`probe-shared-chatgpt-responses.log`、`renderer-final.log`、`batch10-equivalence.json` 及各批 review/report。最终 macOS 产物位于 worktree 的 `clients/desktop/dist/mac-arm64/Nova Audio Agent Desktop.app`。
