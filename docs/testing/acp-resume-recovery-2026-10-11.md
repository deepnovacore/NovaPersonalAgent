# ACP 凭据失败后的同会话恢复修复：2026-10-11

后续修复 [上一轮记录](acp-failure-fixes-2026-10-11.md) 中的新任务仍回复旧 `AUTH_OK`、没有文件产物的问题。
此前把这部分过早归为模型波动；真实请求与原生日志复查定位了具体缺陷。

## 原因和修改

- **Pi 的实际入口不同。** 日常 `pi` 启动 `dist/bundle/cli.js`，加载打包 chunk；之前改 `pi-ai/dist/api/transform-messages.js` 不影响这个入口。现同时覆盖 Pi 1.1.0 的实际 bundle 和 SDK 入口，核查 `package.json.bin.pi`，并校验原始 chunk SHA-256：`a241af84a77843daa77aa29f1b94d9417381fa79539ed668840b756076b3801d`。实际 provider 请求已验证出现恢复边界。
- **失败请求仍作为普通指令进入下一轮。** 只插入“失败状态”不足以消除旧回合的输出限制。现在仅在有后续用户请求、旧请求没有回复或工具进展时，把失败请求的文本标为被引用的历史参考。原文字仍可供“重试上一条”使用，当前请求保持原样；图片、已成功历史、项目和权限约束保留。状态不声称任务已完成，原生会话/日志不改写。
- **DeepSeek 的内部消息打断了检测。** 它在真实用户请求之后加入 `agent-instructions`、`runtime-context` 等 user 角色消息。回查上一条真实用户请求时现在跨过这些内部消息，保留其内容；失败边界由原生 error/aborted 事件确定，后续回合保持稳定 ID。
- **OpenCode 用原生钩子处理。** 使用 1.19.0 的 [`experimental.chat.messages.transform`](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/plugin/src/index.ts)；仅归档有对应错误回复、没有成功回复且已有下一条用户请求的文本。跳过原生 synthetic/ignored 分片；只修改 provider 输入副本，不写 native store、不改变审批、不会自动重放副作用。
- **Nova 的续做提示支持重试。** 当前 work order 为本轮请求；显式重试或继续会保留先前任务的适用约束，不再一概废除旧输出格式。

## 日常安装

本机已经应用；以下脚本也随 runtime 包提供：

```sh
node runtime/scripts/patch-acp-recovery.mjs \
  "$(npm root -g)/@earendil-works/pi-coding-agent" \
  "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai" \
  "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop"
node runtime/scripts/install-opencode-recovery.mjs
```

Pi ACP 的结构化错误补丁仍按上一轮说明应用。恢复补丁只接受已验证版本及官方入口哈希；
OpenCode 安装器检查 CLI 为 1.19.0，同名插件仅允许当前内容或精确哈希匹配的上一版 Nova 插件；其它内容拒绝覆盖。
本机 OpenCode 的公开插件依赖已升到 1.19.0；没有修改用户模型、登录或其它配置。
原生包重装会覆盖 Pi/DeepSeek 补丁，需重新应用；升级到其它版本需重新核查。

## 实跑证据

真实生产 transport、日常 CLI 和提供商，独立合成目录、私有认证副本、原生同会话恢复。
每次新任务都要求生成独立随机文件名和 nonce 内容；只有文件内容匹配、会话 ID 不变和进程收口通过才算成功。

| 后端 | 修正后新任务重复实跑 | 最终续做提示 | “重试上一条” |
|---|---|---|---|
| Pi / 实际 DeepSeek V4 Pro | 连续 5 次通过，provider 请求确认归档 | 另 2 次通过 | 通过 |
| OpenCode / Qwen Flash | 连续 5 次通过，实际钩子归档计数确认 | 另 2 次通过 | 通过 |
| DeepSeek Harness | 连续 5 次通过；前三次确认实际输入归档计数，后两次移除临时诊断 | 使用最终提示 | 通过 |

原始失败、只插入边界仍失败、DeepSeek 内部消息漏判及修正后证据均保留在忽略的
`output/acp-followup-20261011/`，不公开上传。目录内包含私有认证副本。
依赖安装超时和磁盘不足导致的运行未计入通过；只清理了本轮已完成目录的可重建依赖缓存，保留会话和产物证据。

最终元数据保护版本另有一次 Qwen Flash 看见新任务却误拒绝创建随机测试文件，未生成产物；
它没有返回旧 AUTH_OK，此次严格判为失败并保留。随后两次独立复跑通过，不能用通过抹去误拒绝。
已有工具进展的失败保留原历史，不假定副作用可以安全重放。

自动化：恢复/兼容补丁及安装器契约 **14/14**（包含实际安装的 Pi bundle、图片、纯字符串、重试成功历史、
DeepSeek 内部消息和插件幂等性）；ACP/进程归属回归 **79/79**、文档契约 **12/12**。runtime 构建、类型检查和 lint 通过，打包检查包含全部恢复脚本。
本地 Claude Sonnet 5.5 参与设计和实现复核；已处理合成/忽略分片保护及已知旧插件安全升级意见。
DSH 内容按原生 readonly ContentBlock[] 类型处理，工具有进展时保留历史的判断是有意的；未把模型意见当验收证据。

这组凭据恢复复现已修复。有限次数通过不是所有模型行为的保证，Task 仍需产物核验。
本轮不包含完整桌面 UI、Windows 真机、语音、签名安装包或 M9-C 整体验收。

后续 [Windows ACP 实跑](acp-windows-acceptance-2026-10-11.md) 补充了平台结果：Pi、OpenCode、DeepSeek 的同会话恢复产物核验通过，但 CodeBuddy 在 Windows 仍回复旧 AUTH_OK、没有新文件；默认 Windows 启动也尚未修复。本报告中的本机修复结论不能外推为全部平台/后端均通过。

Windows 的上述两项问题随后已修复，见 [Windows 修复复验](acp-windows-fixes-2026-10-11.md)；补丁和启动解析均限制在 Windows，macOS 回归通过。
