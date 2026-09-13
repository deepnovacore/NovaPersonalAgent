# 精简执行记录

目标分支 `plan/slim-2026-09-13`。主工作区未改；未合并、推送或发布。所有十批仍按原计划完成，下面区分实现、集成与验收。

| 批次 | 当前状态 | 证据与边界 |
|---|---|---|
| 1 | 完成并集成 | 旧审计退役、ESLint 静态与动态导入边界、eval 移出 src、旧脚本与死 executor 删除；级联 oracle 的有效断言迁移保留。最后审查无遗留项。 |
| 2 | 完成并集成 | WebUI 及隐藏备份从当前树删除，备份分支不动；运行时 2577 通过/8 跳过，桌面 1028 通过/3 跳过。 |
| 3 | 完成并集成 | 图功能退役，sensitivity 保留，当前规范同步；真实 Chrome 进度界面在三个缩放等级通过。全量运行时仅发现固定提示词快照遗漏一条图说明，精确同步后协议 14 项通过；桌面 1020 通过/3 跳过。 |
| 4 | 完成并集成 | 发布检查收敛到 250 行 verifier，保留实际依赖 staging、原生资源 manifest 和签名路径；真实 macOS 未签名安装副本的后端握手通过。集成桌面 878 通过/3 跳过。签名发布未执行。 |
| 5 | 完成并集成 | Node 文件系统替代原生文件操作；Windows 实际 MSVC 编译、目录刷盘、锁竞争和进程退出后释放、Node 路径身份测试通过。Claude 最终复审 PASS；集成 check、运行时 2327 通过/8 跳过、桌面 878 通过/3 跳过。 |
| 6 | 执行中 | provider-projection 与 host-delivery 已提取，均通过 Claude 关键审查；相关 361 项测试通过。tool/project owner 尚待完成。 |
| 7 | 设计复审中 | 隔离 Codex 实测进程级 API key 不覆盖磁盘认证；确认 config/read 返回继承 provider 字段，整表 TOML 覆盖仍会合并旧字段，需校验实际配置。 |
| 8 | 独立准备中 | 桌面设置及生命周期文件收敛；其余分组待执行。 |
| 9 | 未完成 | 不删除现用行为断言。 |
| 10 | 未开始 | 必须最后迁移目录并检查发布入口和 worker 路径。 |

## 实测修正的计划前提

- 原级联 oracle 在当前基线实际通过；迁移有效断言后才删除，不能依据旧审计的失败描述直接退役。
- Windows `taskkill` 无法在 leader 已退出后清理脱离的后代。保留最小 Job Object guardian；sandbox C probe 是真实生产准入消费者，同样保留。
- 用 `O_EXCL` 或 mkdir 锁不能同时保证多进程崩溃恢复与无竞争接管；保留最小 flock/LockFileEx，不 unlink 锁文件。
- Node Windows 只读目录 fd 无法 fsync。保留极小 native flush：获取 fd 最终路径，以 FILE_ADD_FILE 打开，核对 volume/file identity 后 NtFlushBuffersFileEx，所有临时 handle 关闭。实机通过，失败保持失败。
- Node 路径操作的单用户目录替换竞态上限已在代码说明；不伪造原生相对句柄保证。
- 批 4 旧 build/sign hooks 直接依赖被删脚本，因此同步改接精简后的实际 staging/manifest。签名能力保留不代表完成真实签名发布验收。
- 两处既有测试 fixture 已修复：认证 helper 必须消费 ready 后任务快照；renderer mock 必须提供 microphone.onToggle。生产语义未为测试改变。

最终计量按生产、测试、脚本、文档和审计/历史备份分别统计；文件移动和 import 改写不算净删除收益。
