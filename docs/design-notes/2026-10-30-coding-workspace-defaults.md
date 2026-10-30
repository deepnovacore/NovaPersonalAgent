# 编程执行器与工作区：默认值设计

日期：2026-10-30。来源：迁移 `.env` 时发现旧的 `NOVA_AUDIO_AGENT_EXECUTOR` / `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` 不再生效，由此追问"这块该怎么设计"。本文只是设计与取舍，**没有改代码**；与 `2026-10-26-task-conversations-and-workspaces-contract.md` 的设计 B（Nova 自有工作区）一脉相承。

## 已核实的现状

| 事项 | 现状 | 位置 |
|---|---|---|
| 默认工作区 | 已有：设置 > 环境变量 `CODEX_WORKSPACE` > 托管默认 `~/.nova-audio-agent/workspaces/default` | `clients/desktop/src/main/platform-config.mjs` 的 `productPaths` / `resolveDesktopConfig` |
| 显式设置后的校验 | 只要设置里或环境里**设置了** `CODEX_WORKSPACE`，启动时就检查该目录，不存在直接抛 `workspace_not_found`，**整个应用启动失败** | `clients/desktop/src/main/desktop-startup.mjs` 约 148 行 |
| 未设置时 | 不校验，用托管默认；`ensureDirectories` 负责创建 | 同上 |
| 三个开关 | `EXECUTOR`（单选执行器，空=不选）、`CODING_BACKEND`（新编程会话用哪个后端，默认 codex）、`CODING_MODULE_ENABLED`（编程模块总开关，找不到 Codex CLI 时桌面端自动关） | `runtime/src/config/environment-contract.ts` 85/214/220 行 |
| `EXECUTOR` 的读取者 | `config.ts:394` 与桌面权限判断 `desktop-permissions.mjs:9`（只看是否含 `computer`） | |
| 旧前缀 | 文档明确写"已移除前缀，旧名称不再读取"，所以带前缀的两行是**静默无效**，而不是报错 | `docs/{en,zh-CN}/configuration.md` 第 3 行 |

## 真正的问题

1. **失败范围过大。** 一个失效的 `CODEX_WORKSPACE` 会让整个应用起不来。编程只是其中一个模块，不该拖垮记忆、画像、时间线、聊天。
2. **"显式设置"没有失效回退。** 用户把仓库搬了位置（比如换了机器），原配置立刻变成启动失败。
3. **三个开关语义重叠。** `EXECUTOR`、`CODING_BACKEND`、`CODING_MODULE_ENABLED` 都在回答"编程用不用、用谁"，但分别由不同层读取，组合出来的状态难以推理。
4. **默认已经够用，但没有说清楚。** 绝大多数人不需要设置 `CODEX_WORKSPACE`；`.env` 里留一份旧值反而是隐患。

## 建议的设计

**原则：托管默认工作区是唯一默认；显式路径是例外，失效时降级而不是崩溃。**

1. **默认不设。** `CODEX_WORKSPACE` 保持可选，文档把它标成"高级/无头主机用"。桌面端默认只用 `~/.nova-personal-agent/workspaces/default`（目录改名见 `chore/npa-home-dir`）。
2. **失效即降级。** 显式路径不存在或不是目录时：编程模块报 `coding_unavailable: workspace_not_found` 并在设置页提示"路径失效，可改回默认或重新选择"；其余模块照常启动。具体做法是把 `desktop-startup.mjs` 里那处 `throw` 改为向 `CODING_MODULE_ENABLED=false` 的既有通道写原因（同类已存在：找不到 Codex CLI 时自动关闭）。
3. **额外目录靠界面批准，不靠环境变量。** 沿用设计 B：托管工作区列表 + "其它文件夹…"（高级项）。环境变量只给无头部署。
4. **开关收敛。** 对外只保留一个概念"编程后端"（取值 `none|codex|opencode|codebuddy|pi|deepseek`，默认 `codex` 且 CLI 可用时才生效）。`CODING_MODULE_ENABLED` 退化为内部由"后端是否可用"推导的状态，不再作为用户可配置项；`EXECUTOR` 保留给"computer/browser/mobile"这类设备执行器，不再兼任编程选择。这一步涉及契约和文档，改动大，应单独评审。
5. **迁移。** 预研产品没有兼容层要求（见既有决定"预研阶段不写迁移/兼容层"）：旧前缀名直接删，不做别名读取。

## 取舍与风险

- 第 2 条会改变"配置错了就立刻失败"的行为：好处是不拖垮其它模块，代价是用户可能没注意到编程被关了。所以**必须**在设置页和任务入口给出明确的不可用原因，不能只写日志。
- 第 4 条会动环境契约，`documentation-contract.test.ts` 与生成的文档块都要同步，范围不小，建议第 1–3 条先做，第 4 条另开。
- 第 3 条里"其它文件夹"依赖设计 B 的 `workspaces.list/create`，如果那部分尚未实现，则先只做第 1–2 条。

## 建议的实施顺序

1. 第 2 条（降级而不是崩溃）+ 测试：构造一个不存在的显式工作区，断言应用其余部分启动、编程报不可用原因。
2. 第 1 条（文档把 `CODEX_WORKSPACE` 标为高级项）。
3. 第 4 条单独评审后再做。

## 待用户确认

- 是否接受"默认不设、失效降级"作为方向？
- `EXECUTOR` 是否确定只保留设备执行器含义？
