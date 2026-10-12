# Windows ACP 默认启动与 CodeBuddy 恢复修复：2026-10-11

修复 [Windows 首轮验收](acp-windows-acceptance-2026-10-11.md) 的两项失败。
源码为 `v0.4.0dev` 基线 `ea1c2a24713de7b7aa993562be2b16c6c177f027` 加本次工作区修改；
Windows Server 2022 x64 上已应用并实跑，未把结果外推为完整桌面或 M9-C 签收。

## 修复

- **默认启动是宿主适配缺陷。** Windows 分支解析 PATH 和标准 per-user npm prefix，校验固定包名、bin 入口及包内 canonical 路径。
  OpenCode 使用原生 opencode.exe；CodeBuddy、Pi ACP、DSH 使用原生 node.exe 加固定 npm 入口 argv。
  不解析或执行 cmd shim 内容，不使用 shell:true，不降低 Windows guardian 的原生 PE/Job Object 校验。
  桌面“已安装”探测补上同一标准 npm prefix；Pi 的 RPC 子进程也能从 Windows PATH 找到日常 CLI。
- **CodeBuddy 恢复失败来自原生上下文投影。** 原生历史同时保存旧用户请求、带 providerData.error 的认证失败回复和新请求。
  `filterApiErrorMessages` 删除错误回复，后续 `mergeConsecutiveUserMessages` 把旧请求和新请求合并，旧输出限制继续生效。
  不是 ACP SDK 没有把新 work order 发出去；修复前原生日志已确认新请求存在。
- **CodeBuddy 补丁仅用于 Windows ACP。** 在错误记录被过滤之前，识别没有成功回复或工具进展的失败请求，
  将其文本变成历史参考并加入明确的 runtime failure boundary。只改 provider-input 副本，原生日志、当前请求和图片保留；
  不自动重放有工具进展的失败。空输出占位块不算成功进展；原生 function_call/result/output 均保留进展语义。
  Windows 普通交互 CLI 和 macOS 不进入此投影分支。
- **补丁丢失会拒绝启动。** Windows CodeBuddy 支持已核验的 2.164.0 npm ACP 入口；启动核查实际 bundle 完整 SHA-256。
  重装/升级覆盖补丁后不会静默回到旧行为，需重新核查版本并应用补丁。未经核验的 native CodeBuddy executable 不在本轮支持矩阵。

原始 CodeBuddy bundle SHA-256：`f9affe2aed036a3a3ee8486b82e77b176a2a4b21f7bed721074c1c1e4a312e65`。
最终 Windows 补丁 bundle SHA-256：`d1eddce5d8293bf37ca99dc231dda6313c1e5ea70e94f80bfadd2227285a5b85`。
安装器校验版本、反转精确已知补丁后校验原始哈希、原子替换并支持幂等执行；不同内容拒绝覆盖。

Windows PowerShell 重装后应用：

```powershell
$npmRoot = (npm.cmd root -g).Trim()
node runtime/scripts/patch-codebuddy-recovery.mjs (Join-Path $npmRoot '@tencent-ai/codebuddy-code')
```

## 生产路径实跑

最后一轮使用真实生产 AcpTransport、修复后的默认启动解析、编译的原生 Windows Job guardian 和真实提供商。
验收宿主不再改写 launch spec 的 executable/argv。凭据 home 隔离，CLI discovery 显式保持绑定宿主安装目录；
每个新目录设置 owner/SYSTEM ACL。纯默认宿主环境下另跑四后端 preflight，全部握手成功。

| 后端 | 拒绝 | 取消 | 崩溃 | 无效凭据 | 同会话恢复及文件内容 |
|---|---|---|---|---|---|
| OpenCode 1.19.0 | 通过，真实权限拒绝 | 通过 | 通过 | 通过 | 通过 |
| CodeBuddy 2.164.0 | 通过，真实权限拒绝 | 通过 | 通过 | 通过 | 通过 |
| Pi ACP 0.0.34 / Pi 1.1.0 | 不支持 Ask，派发前明确拒绝 | 通过 | 通过 | 通过 | 通过 |
| DSH 0.2.0-rc.2 | 通过，真实权限拒绝 | 通过 | 通过 | 通过 | 通过 |

共 **20/20 场景检查通过**。取消/崩溃均确认命令已启动，取消或杀死 owner 后等待 16 秒，无晚写文件且 Job 清空。
恢复要求 session ID 不变、随机文件名和 nonce 内容匹配，不能只看协议 completed。
CodeBuddy 在最终生产路径下 **3 次独立新任务恢复通过**；另跑“重试上一条失败请求”也通过。
此前连续三次 AUTH_OK 失败、缺少 Bash、模型文字拒绝，以及隔离 APPDATA 导致测试宿主丢失 CLI discovery 的记录均保留，未计入成功。
Pi 已配置现有 Git Bash；Windows 拒绝用例使用普通文件任务触发原生审批，macOS 原用例提示不变。

私有原始证据位于忽略的 `output/acp-windows-20261011/` 及 Windows 隔离验收目录；只收集报告，不公开上传认证文件。
最终运行名为 `windows-production-final-*`、`windows-production-codebuddy-recovery-{2,3}`、`windows-production-codebuddy-retry`。

## macOS 回归与复核

- 改动后的 macOS ACP/进程归属回归 **83/83**；桌面设置、能力和启动反馈 **26/26**。
- macOS 日常 CodeBuddy 包仍为未打补丁的原始 bundle；生产 transport 真实 ACP 握手和关闭成功。
- CodeBuddy 新契约在 macOS **4/4**；Windows 启动及恢复契约 **15 通过 / 0 失败 / 1 平台跳过**。
- runtime 构建、类型检查、lint、打包检查通过；包中包含 Windows launch module 和依赖的恢复安装脚本。
- 本地 Claude Sonnet 5.5 参与复核，处理补丁覆盖后静默回退、空输出占位块、工具结果、测试路径/权限以及隔离 home 的 CLI 绑定意见。
  Native executable 的实际 PE 校验仍由生产 guardian 完成，测试用 guardian 来自本轮 Windows 编译；未把测试 allowlist 当成发布包 manifest 验收。

本轮没有修改 macOS 日常 CLI 安装或原生历史，也没有在 main 提交或推送。
未验收完整桌面 UI、语音、签名安装包、升级或 Windows GUI 执行；有限模型实跑不保证所有模型行为，Task 仍需产物核验。
