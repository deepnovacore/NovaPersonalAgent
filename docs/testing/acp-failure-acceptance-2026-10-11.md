# ACP 异常路径实跑：2026-10-11

结论：**未整体验收通过**。按用户决定，v0.4.0 不接入 Kimi Code；本轮覆盖四个已接入 ACP 后端。
运行代码为 `v0.4.0dev@9ec6e6ec`；新增的实跑脚本与本文不修改生产 transport。
平台为本机 macOS，实际调用已安装 CLI 和真实提供商，并使用生产 `AcpTransport`、
`PosixCodexProcessOwnerFactory`。覆盖传输层和后端真实执行，不覆盖桌面 UI 或 durable Task 收口。

| 后端 | 拒绝 | 运行中取消 | 硬崩溃后停止副作用 | 无效凭据 → 原会话恢复 |
|---|---|---|---|---|
| OpenCode 1.18.31 / qwen-flash | 通过：审批 1 次，拒绝后未写文件 | 通过 | **失败：工具继续写迟到标记** | 通过：错误后恢复，同会话正确文件 |
| CodeBuddy 2.154.0 / hy4-preview | 通过：审批 1 次，拒绝后未写文件 | 通过 | 通过：未写迟到标记 | 通过：错误后恢复，同会话正确文件 |
| Pi ACP 0.0.33 / Pi 0.84.2 / deepseek-v4-flash | Ask 启动前拒绝；不支持逐工具审批 | 通过 | **失败：工具继续写迟到标记** | **部分失败：401 被误报完成；恢复后同会话文件正确** |
| DeepSeek Harness 0.1.5-rc.2 / deepseek-v4-flash | **此场景未通过：普通写文件不发审批请求** | 通过 | **失败：工具继续写迟到标记** | **失败：认证恢复但续做未生成要求的文件** |

## 判据与证据

- 拒绝：Ask 请求创建合成文件，host 的审批控制器一律 decline。必须观察到审批且文件不存在。
  Pi 则验证 `refused/unsupported_protocol`、`turnWritten=false`，这是功能不支持的明确拒绝，不能称为逐工具审批通过。
- 取消/崩溃：工具执行一个 Node 命令，先写 started 标记，再等 15 秒写 late 标记。
  观察到 started 后才触发 AbortController 或 owner.killTree；随后等待 16 秒检查 late。
  所有触发有效的运行都返回 uncertain：取消 `adapter_timeout`，崩溃 `transport_lost`。
  判断是否停止副作用看 late 标记，不能只看 owner.waitTreeGone。
- 凭据：只修改隔离 HOME/环境里的 key，再恢复原副本并使用原 session ID 提交新文件要求。
  必须检查实际文件内容与随机 nonce 相等；`completed` 或相同 session ID 本身不足以通过。
- CodeBuddy 首轮隔离 HOME 缺登录文件，属于环境阻塞，不能算后端通过或失败。
  定位其原生加密认证文件后只复制该文件复跑，四项通过；没有复制个人会话、插件或 MCP 配置。
- Pi 首轮脚本错误地期待 `approval_unavailable`，原始结果实际是 `unsupported_protocol`。
  修正判据后独立复跑 Ask 通过；保留首轮原始证据。

私有原始证据存于忽略的 `output/acp-failures-20261011/`：四后端首轮目录、
`codebuddy-native-auth`、`pi-reject-final`、`pi-credential-diagnostic`、
`deepseek-recovery-retry` 和各后端 `*-crash-pids`。
这些目录含隔离凭据副本，不能提交、上传或公开分享；公开本文仅保留合成行为与结果。

## 已确认的问题

1. **崩溃后残留工具执行。** OpenCode、Pi、DeepSeek 的初轮均在硬杀后写出 late。
   owner 只向自己的 POSIX 进程组发送信号并检查该组消失，不等于所有后代执行停止。
   额外 PID/PPID/PGID 采样已确认 Pi、DeepSeek 的测试工具 PGID 与 owner 不同。
   OpenCode 采样复跑出现 `unsettled top-level await`（退出码 13），未得到完整 report，
   记录为追加收口异常而非通过；首轮完整失败证据仍有效。最终脚本增加独立 watchdog，
   防止这类退出收口挂起导致报告缺失。
   不把 owner 的清理证据当成“没有后续副作用”；修复需能证明归属，不能杀无关进程。
2. **Pi 提供商错误被包装成成功回合。** 安装包 `pi-acp/dist/index.js:2435` 明确把
   非取消的 `result === "error"` 映射为 `end_turn`。真实无效 key 的原生会话为 error/401，
   ACP 的非空最终文本仅为 Pi 横幅，Nova 因而返回 completed。恢复后同会话产物正确。
   不采用匹配人类错误文本或横幅的补丁；优先修正后端结构化错误信号，产物验证必须保留。
3. **DeepSeek 恢复后续做异常。** 首轮及独立复跑恢复凭据后均完成同 session 回合，
   但没有新文件；复跑最终文本是上一条失败请求的 `AUTH_OK`。认证已恢复，任务效果未恢复。
   尚未定位是原生会话重试行为还是 ACP 历史/消息处理，不能提前归因。
4. **DeepSeek 的审批覆盖有限。** 本次普通文件写入没有发出 request_permission，decline 回调没有机会生效。
   这与 ACP Ask 不提供文件/网络沙箱的既有限制一致；该用例没有证明逐项拒绝有效，
   也没有证明后端完全不支持原生审批。支持矩阵需按实际操作范围描述。

## 独立复核与复现

已用本地 Claude CLI、指定 `claude-sonnet-5-5` 做两轮只读 review/讨论。
材料仅包含源码与脱敏事实，没有提供凭据或用户会话。对它关于所有后端的汇总结论及
未测量 PGID 时的推断逐条核实、纠正；以上矩阵以原始实跑结果为准。

从仓库根目录运行（会调用真实提供商；输出目录必须是尚不存在的 `output/` 子目录）：

```sh
node runtime/scripts/live/acp-failures.mjs opencode output/acp-failures-new/opencode /path/to/private.env
```

可将后端替换为 `codebuddy`、`pi` 或 `deepseek`。脚本依赖已构建的 `runtime/dist`、
本机 CLI 和原生认证配置；采用本轮实际模型，不是任意部署通用配置生成器。
`ACP_FAILURE_CASE=reject|cancel|crash|credentials` 可单独复跑。
这些检查仍不是完整 Task、GUI、语音或安装包验收。
