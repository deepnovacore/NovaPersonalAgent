# 精简分支复审与集成

审查范围 `62520e20..d00b57cc`。用户要求先修复问题，再本地合入 `v0.2.0dev`。本记录接续原精简执行记录；原记录中的未合并状态对应当时的验收时点。

## 多模型复审

| 模型 | effort | 范围 | 结论 |
|---|---|---|---|
| terra | low | 模块迁移、导出、worker、WebUI/graph 退役 | 无确认回归 |
| terra | medium | 知识库直调、deadline、PendingDecision、schema | 无确认回归 |
| terra | high | Node/native 文件操作、恢复、共享 HOME、授权 | 共享 HOME 配置兼容 P2 |
| sol | low | 剩余重复代码、兼容层与小型抽象 | 默认值和 Guard 别名可进一步收敛 |
| sol | medium | service owner、desktop lifecycle/assembly、取消 | 无确认回归 |
| sol | high | 发布工作流、staging、安装 verifier | 发布附件版本 P2 |

各模型分工不同，不把结果用于模型能力排名，也不声称每路都遍历了全部文件。交叉核验后保留两项 P2，未确认 P0/P1。

## 已修复的问题

修复提交 `0148c089`，Sol high 独立复审通过。

1. 新建项目改用共享 HOME 后，合法的 `mcp_servers."corp.tools"` 等名称会在 `sharedHomeOverrides` 中被拒绝，连已禁用条目也会阻止 `thread/start`。现在复用已有 TOML serializer，按 inline table 覆盖外部条目的 `enabled=false`。不复制外部配置值或密钥，不修改磁盘配置；最终有效配置仍严格验证。真实 Codex 0.154.0 验证带点、引号、反斜杠、中文名称全部正确禁用，managed 条目保持启用，配置文件字节不变。不能改用带引号的 dotted CLI key：当前 Codex 会错误分割它。
2. candidate 直接用手填版本命名附件、publish 只数八个文件，可能放行包版本 Y 与附件名版本 X 的组合，使 CLI 下载 404。现在 candidate 构建前和 publish 共用一个无依赖版本检查，拒绝非稳定 semver、输入与 CLI/desktop 包版本不一致的情况。

修复定向测试 18 项通过；两个回归均先观察失败，再验证修复。复审阶段额外执行的 verifier 3 项、backend/settings 110 项通过；回环监听的初次 EPERM 经允许本机监听后消除，未记为代码缺陷。

## 合并时保留的增量

`v0.2.0dev` 在基线后另有 10 个提交，合并前为 `f8c142c2`。在精简 worktree 中整合这些提交，保留 DeepSeek、Watch 独立模型连接、Omni 默认 Ethan 音色、延迟关联、桌面任务卡片/设置/配对/用量与记忆账本设计。

延迟统计的播放开始事件落到 `HostDelivery`，新增 service 测试迁入拆分后的 projection 测试文件；不恢复已退役的大测试文件、parity 审计、旧导入 allowlist 和打包检查器。主工作区既有未跟踪计划文档不纳入本次提交。

## 验证与合并状态

整合后的 `npm run check` 已通过；全量 `npm test` 退出码为 0：

| 套件 | 通过 | 条件跳过 | 失败 |
|---|---:|---:|---:|
| Runtime | 2336 | 8 | 0 |
| Desktop | 880 | 3 | 0 |
| CLI | 21 | 0 | 0 |

额外执行的延迟分析脚本测试 1 项通过。Desktop 默认 source-startup smoke 未启用；此前的 Windows 原生、真实取消回收和 macOS 安装副本验收属于原执行记录，本轮没有重跑这些完整验收。

集成方式：保留 `0148c089` 与主线 `f8c142c2` 两侧历史，在精简 worktree 完成 merge commit，再本地快进 `v0.2.0dev`。未推送、发布或执行远程 CI。原始测试日志在 `/tmp/nova-slim-merge-20260913/`，最终全量日志为 `test-final.log`，静态检查为 `check-final.log`。

首轮整合全量测试暴露 5 个测试契约不匹配：3 个入口 mock 未提供主线新增调用的 `telemetry.record`，1 个 JSONL 断言未验证新增运行标识字段，1 个文档退役检查发现旧名称引用。已修正 mock、完整验证遥测载荷与新字段，并在当前规格中去除旧实现依赖；相关 76 项定向测试通过，随后重跑全量。

## 后续可选精简

优先合并 `backend.mjs` 与 `settings-store.mjs` 的重复默认值，再在确认导出兼容边界后退役内部 Guard 别名，主要生产代码收益粗估约 50–70 行。保留旧环境变量解析兼容。`assignAssembly` 和重复的 `freezeWorkspaceContextDelivery` 收益很小，可随相关改动处理。这些建议尚未实施，不计入已实现减量。

## 最终代码规模

统计对象为本次整合后的 Git 跟踪源码，按物理行计数（含注释和空行），扩展名为 `.ts/.js/.mjs/.cjs/.c/.h/.swift/.html/.css/.sh`。不计 `node_modules`、`dist/build` 产物、未跟踪文件、图片音视频、文档、JSON fixture、锁文件、工程配置与 YAML 工作流。iOS 的 `NovaTests/Checks` 及脚本目录中的 `.test.*` 归测试；`Package.swift` 归工具。

该口径明确分离 iOS 测试、原生模块说明文档与工程描述，与原执行记录的“生产目录全部文本”口径不同，不能直接相减。随包评测从 `src` 迁出，仍单列计入代码总量。

| 系统 | 生产源码 | 评测 | 测试代码 | 工具脚本 | 合计 |
|---|---:|---:|---:|---:|---:|
| Runtime | 68,033 | 1,920 | 79,989 | 1,563 | 151,505 |
| Desktop（含 native） | 20,800 | 0 | 19,561 | 5,369 | 45,730 |
| iOS | 2,098 | 0 | 476 | 26 | 2,600 |
| CLI | 856 | 0 | 375 | 0 | 1,231 |
| 仓库级工具 | 0 | 0 | 0 | 405 | 405 |
| **总计** | **91,787** | **1,920** | **100,401** | **7,363** | **201,471** |

生产源码加随包评测共 **93,707 行**。WebUI 和 Workspace Graph 已退役，不作为现存系统列入。

### Runtime 生产模块

| 模块 | 行数 |
|---|---:|
| `runtime/entries` | 1,521 |
| `runtime/composition` | 2,413 |
| `runtime/config` | 1,606 |
| `runtime/core` | 6,296 |
| `runtime/desktop` | 3,553 |
| `runtime/executors` | 15,931 |
| `runtime/knowledge` | 2,423 |
| `runtime/memory` | 1,214 |
| `runtime/model` | 941 |
| `runtime/projects` | 5,553 |
| `runtime/realtime` | 23,990 |
| `runtime/server` | 943 |
| `runtime/storage` | 152 |
| `runtime/text` | 606 |
| `runtime/voicemem` | 891 |

### Desktop 生产模块

| 模块 | 行数 |
|---|---:|
| `desktop/native` | 2,160 |
| `desktop/src/main` | 7,294 |
| `desktop/src/preload` | 173 |
| `desktop/src/renderer` | 11,173 |

### iOS 生产模块

| 模块 | 行数 |
|---|---:|
| `ios/Audio` | 490 |
| `ios/Connection` | 735 |
| `ios/entry` | 29 |
| `ios/Protocol` | 438 |
| `ios/Views` | 406 |

`runtime/entries` 是根层 5 个公开入口；`runtime/executors` 含 Codex/coding、Vision、Search 等执行器，`runtime/realtime` 含级联语音适配器。CLI 的 `src` 与 `bin` 合计 856 行。
