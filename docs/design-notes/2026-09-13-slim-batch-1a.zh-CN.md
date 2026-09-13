# 瘦身批 1a：过期对齐审计与未实现 embedding 入口

范围：`plan/slim-2026-09-13` / `.worktrees/slim-plan`，从计划 HEAD `6dbd810e` 开始。
本记录只对应批 1 的两个闭合子项，不代表批 1 或整个瘦身计划完成。

## 前置修复与环境

- 复用公共主分支 `f8c142c2` 的 qrcode 打包契约修复，独立提交为 `ddd6e222`。计划树已经依赖 qrcode，却未在打包检查中允许；主工作区同一用例通过。该修复不计入精简收益。
- 开工时目标 worktree 干净；主工作区的未跟踪设计文档保留。
- 验证使用已安装依赖的 APFS 本地克隆，未改依赖或 lockfile。最初缺依赖导致 MCP 子进程、Electron 测试失败；符号链接又被包身份校验拒绝，最终使用实际目录。
- 无 Windows 原生实现改动，未运行 aliyun-win；无合并、推送、部署或发版。

## 交付行为

- 删除 node-parity 审计 JSON、两个脚本、专属测试和根 check 的调用。Python 源树已不存在；实际使用的 python-text/unicode 生产代码全部保留。
- 审计测试末尾的现用文本兼容用例原样迁至 `runtime/test/python-text.test.ts`：Python 空白、BOM、astral code-point length 的断言未删除。
- embedding 仅允许当前实现的 DashScope。移除禁用的 local UI 选项和当前规格中的预留承诺；模型、地址、知识库导入/索引/检索与错误处理保留。
- runtime 的旧 local / 未知 provider 经既有 zod selector 拒绝，继续使用 `ConfigurationError`，消息含字段与允许值。
- 桌面显式不支持的 provider 在 normalize/load/save 阶段拒绝，不恢复成云端默认值。启动显示不含原配置值的错误提示和配置文件位置，后端不启动，用户明确修正服务选择后再重启。
- recovery 文件也采用同一校验，且先校验再回滚 capability sidecar；无效恢复记录、原设置和能力文件均保留。

## 减量账本

以下是本子批次的物理行差分，排除前置 qrcode 修复、计划和执行记录；搬迁的文本断言不当作功能删除。

| 类别 | 新增 | 删除 | 净减少 |
| --- | ---: | ---: | ---: |
| 生产源码 | 24 | 10 | -14（增加保护边界） |
| 工具脚本 | 0 | 189 | 189 |
| 测试（含迁入文本用例） | 92 | 197 | 105 |
| package 配置 | 1 | 2 | 1 |
| 旧审计 JSON | 0 | 5,132 | 5,132 |
| 当前产品规格 | 16 | 15 | -1 |

主要收益是退役维护负担；不能将 5,132 行 JSON 宣称为生产源码减少。新依赖为 0。

## Review 与验证

- Claude CLI / `claude-fable-5-1` 只读 review：发现 raw ZodError 类型和桌面启动无提示的问题，已修复。
- Terra 只读 review：发现 recovery 错误被通用 catch 吞掉、残留规格承诺，已修复；复核无剩余可操作问题。
- 新回归测试先复现失败，再验证修复；现用测试未为追求绿色而删除。
- `npm run check`：通过（typecheck、eslint、env contract、wire、executor boundary、capabilities）。env contract 无原有 local 枚举承诺，生成内容未变化。
- `npm run test:cli`：21 通过。
- 桌面全量：1,025 通过，3 跳过，0 失败。
- runtime 全量：2,600 通过，8 跳过，0 失败。采用 `--test-concurrency=4`，避免无限制文件并发使 MCP 的短 timeout 用例争用超时。
- Chrome 知识库设置页：仅有 DashScope option；本地选项缺席；模型与存储路径显示正常；无页面 JS 错误。截图 `/private/tmp/nova-slim-settings-renderer/knowledge-settings.png`。
- 原有完整 `renderer-capabilities-smoke.mjs` 在旧的“相机与视觉”定位器处超时；本批未改该脚本。使用相同初始化的定向 Chrome 验收覆盖本次页面变动，未声称完整 smoke 通过。

## 下一批仍需执行

批 1 的 executor-boundary 规则收敛、oracle 现用断言迁移、eval 搬迁、retired env 清理、live-smoke 合并、迁移文档及本地垃圾清理尚未执行。批 2–10 未开始。
