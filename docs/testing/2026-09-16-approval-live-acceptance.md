# 网络与浏览器审批验收（2026-09-16）

## 根因和修复

真实 Codex `item/commandExecution/requestApproval` 报文使用 `environmentId: "local"`，且 `availableDecisions` 包含 `accept`、永久策略修改对象和 `cancel`。Nova 原来拒绝所有非空 environmentId，并要求决策目录显式包含 `decline`，因此请求在发布桌面审批前就被静默拒绝。

最小修复：允许当前本地环境（仍拒绝远端），仅从目录选择允许的批准范围，始终保留拒绝当前操作的 `decline`。不返回 `cancel`，不添加永久策略，不根据命令关键词推断网络意图。permissions 请求同步接受本地 environmentId。Fable 复核纠正了最初将拒绝映射为 cancel 的方案；拒绝不能意外中断整个 turn。

## 实际证据与边界

使用独立临时工作区、真实 Codex 0.154.0、生产 DesktopRealtime WebSocket、生产 renderer 审批解析器和决策控制器。直接提交明确测试 work order，未经过 Qwen 意图识别。没有重启用户客户端。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 联网请求批准 | 通过 | 收到真实 curl 审批，控制器经 WebSocket 回传一次批准；下载 559 字节并独立读回标题 Example Domain |
| 公共网页 preview 打开 | 通过 | open 请求审批回传一次，命令 exit 0；CUA 验证 Safari 新标签页 URL 和 Example Domain 标题、正文，用户亦确认显示 |
| 网络审批拒绝 | 通过 | 前端回传拒绝，未产生下载文件；Codex 正常完成解释，没有中断 turn |
| 原生 Nova 横幅点击 | 未验收 | 使用生产前端决策控制器调用，不等同于原生按钮点击 |
| 麦克风语音确认与播报 | 未验收 | 本次没有经过物理音频链路 |
| 本地 HTML / 开发服务器 preview | 未验收 | 仅验证公开 HTTPS 页面，不扩大为所有 preview 都通过 |

公共测试 URL 为 `https://example.com/?nova-preview-approval=20260916`。私有诊断位于 `.data/diagnostics/2026-09-16-live-repair/`：`approval-wire.jsonl`、`approval-network-report.json`、`approval-preview-report.json`。报告不保存其他 Safari 标签信息，也不提交真实凭据或完整用户 telemetry。

## 哪些固化为本地测试

| 行为 | 本地测试方式 | 状态 |
| --- | --- | --- |
| 当前真实审批报文兼容 | curl/open 请求形状；local 环境；cancel-only 目录；批准与拒绝回包 | 已新增 regression |
| 授权边界 | 错 turn、远端环境、cwd 越界、超大决策目录、禁止永久策略和未提供的 session grant | 已覆盖 |
| 审批生命周期 | 过期、断线、重复决定、旧 ID、队列、仅一次回包 | 复用现有协议及 E2E 测试 |
| 前端审批投影 | 严格帧解析、批准范围、一次性决定；真实 loopback 传输 | 复用现有 desktop/controller 测试 |
| tool result 后取消再继续 | 保存完整调用/结果配对，不残留待回填调用 | 本轮已有 Qwen adapter regression |
| 进度去重 | 新 prose 可发布，只有计数变化不重复旧计划 | 本轮已有 projection regression |
| 最终回复包含原任务上下文 | 原始任务作为上下文，不作为执行成功证据 | 本轮已有 host projection regression |
| 多轮澄清与自然口播 | 本地测试历史/引用传递；实际模型语义需 opt-in live eval | 当前第三轮仍有只口头承诺不 dispatch 的失败样本，不能宣称通过 |
| 外网实际连通、浏览器实际渲染 | 真实 Codex + 网络/OS；检查实际文件/页面而非只看 turn completed | 保留 opt-in live 验收 |
| 长语音分段和物理播放 | PCM 重放可测事件生命周期，麦克风/声学效果需要真机 | 不能用 mock 代替真机结论 |

最终验证：build、lint、diff whitespace 检查通过；审批、app-server transport 和 desktop 控制器测试共 131 通过、1 跳过、0 失败。

本地审批检查命令（需允许本机 loopback 监听）：

```sh
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/codex-approval-transport.test.js runtime/dist/test/codex-approval-e2e.test.js runtime/dist/test/codex-app-server-transport.test.js clients/desktop/test/confirmation-controls.test.mjs
```

模型只说“已完成”或 transport 返回 `completed` 都不构成执行成功：联网必须验证下载内容，preview 必须验证目标页面。测试断言作用于可观察协议和结果，不给产品增加关键词路由。
