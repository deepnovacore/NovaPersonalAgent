# ACP 异常路径升级与修复：2026-10-11

承接 [首轮实跑](acp-failure-acceptance-2026-10-11.md)，按用户要求先升级，再修复仍存在的问题。
用户授权直接替换日常 CLI；本轮已升级全局安装，并保留原生用户配置/登录。
公开修改在 `v0.4.0dev`，没有修改或推送 `main`。

| 组件 | 原版本 | 当前版本 |
|---|---|---|
| Nova ACP SDK | 1.3.0 | 1.8.0，package-lock 固定 |
| OpenCode | 1.18.31 | 1.19.0 |
| CodeBuddy | 2.154.0 | 2.164.0 |
| Pi ACP | 0.0.33 | 0.0.34 + 下述精确校验兼容补丁 |
| Pi Core（当前发行组织 @earendil-works） | 0.84.2 | 1.1.0 |
| DeepSeek Harness | 0.1.5-rc.2 | 0.2.0-rc.2 |

## 已定位与修复

### 进程所有权与退出收口

新增 ACP 专用 POSIX 工厂，启动时设置每次执行独立的随机环境标记。
工具退出原进程组或被 reparent 后，标记仍可识别本次执行的进程；发信号前复核 PID、
启动时间及标记。默认原生工厂启动后验证根进程确实保留标记。Windows 继续使用注入的 Job Object guardian。
扫描错误会阻止启动或保留不确定收口，不能解释为空树；不会输出进程环境、凭据或原始扫描错误。

清理先尝试原进程组，再处理已识别的跨组成员；SIGTERM 后仍未停止会升级 SIGKILL。
发送 ACP cancel 后有界等待，让后端有机会处理取消。已销毁 stdin 不再等待永远不来的回调，
关闭等待有界，并保留处理迟到 EPIPE 的监听器。移除旧的直接 spawn 分支，所有 ACP 共用所有权路径。

这是已实跑工具链的进程归属清理，**不是对抗性 OS 沙箱**。`env -i`、sudo、远程执行、
复用已有服务等链路可能丢弃标记，未认证为可可靠收口。POSIX 主机需要可用的 `/bin/ps`；
其不可用时失败关闭，不继续执行。注入的自定义工厂须保留传入环境。

### Pi 结构化错误

Pi ACP 0.0.34 的 `agent_settled` 原实现仍无条件返回 end_turn；仅修旧的 error→end_turn 分支不够。
兼容补丁在 settlement 时读取 Pi RPC 的 get_messages，仅检查**最新 user 之后**的 assistant：
原生 error、缺少回复或 RPC 失败返回通用结构化错误；不解析错误文本，也不泄露提供商诊断。
明确取消仍保持取消，历史错误不污染已成功的新回合。

补丁只接受 `pi-acp@0.0.34`，反向还原后必须匹配官方发行入口文件 SHA-256：
`324aeb8bba1228937e16b1326fb3e014e2a625b2dea549dbcd49b006cd5df6a2`。
幂等应用，未知版本或其它源码变化拒绝修改，保留原文件权限并原子替换。
脚本随 runtime 包提供，本机已经应用：

```sh
node runtime/scripts/patch-pi-acp.mjs "$(npm root -g)/pi-acp"
```

重新安装同版 Pi ACP 会覆盖补丁，需要重新运行此命令。升级到其它版本时必须重新核对上游修复，
不能把本补丁套上去，也不能仅凭包版本认定凭据错误已正确报告。

### 原会话恢复与模型行为

脱敏 ACP 帧和原生日志证明新 work order 已写出并持久化，没有协议丢消息。
Pi 会丢弃 error/aborted assistant，DeepSeek 的失败回合可能没有 assistant；
前后用户请求因此缺少失败边界。续做提示保留项目、安全和权限约束，明确当前请求。
另提供精确版本/入口 SHA 校验的 `patch-acp-recovery.mjs`：在模型输入视图中加入明确标注的
运行时失败状态，不重放部分思考或错误内容，不改原始日志，不宣称任务完成。
Pi 仅在失败消息下一条为 user 时加入边界；连续失败只插入一次，原回合重试成功的历史不插入状态。
DeepSeek 根据原生事件中的 error/aborted 标记对应 user，在无 assistant 的相邻用户请求之间加入边界；
历史边界在后续成功回合仍保留，ID 由原消息 ID 派生，输入数组复制后修改，不改缓存或日志。

本机已应用：

```sh
node runtime/scripts/patch-acp-recovery.mjs \
  "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai" \
  "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop"
```

仅支持 `@earendil-works/pi-ai@1.1.0`（原入口 SHA-256
`9d747a3d64c533f7bfaf2a66e8446dc006086559d364a09d4c51d1c8c9c332e5`）和
`@deepseek-ai/dsh-agent-loop@0.2.0-rc.2`（
`00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2`）。
幂等、原子替换，未知源码拒绝修改；重新安装覆盖后需重新应用，升级须重新核查。

DeepSeek 加边界后两次独立恢复和复核修正后的最终实跑均生成新 nonce 文件。
Pi 一次通过、独立重复及复核修正后仍回复旧 AUTH_OK 且无文件；OpenCode/Qwen Flash 也有一次同类失败。
这些是新请求已到达之后的模型任务遵从问题，**未完全修复**，不抹去失败、不签模型稳定性。
Pi 原生日志实际选用 `deepseek-v4-pro`，虽然隔离配置默认值为 `deepseek-v4-flash`；
旧报告的 `model` 是配置意图，现改为 `configuredModel`，不能视为实际模型证据。
`completed` 仅表示回合结束，任务交付仍需文件/命令证据与 Task verifier；没有放宽判据。

### DeepSeek Ask 与拒绝收口

原生 profile 默认 workspace-write，以前 Nova 没有传递自己的 Ask/Full 意图。
现在 Nova 控制 `DSH_PERMISSION_MODE`：Ask→read-only，Full→danger-full-access，
不接受环境里对该意图的覆盖。此映射针对已核查的原生 profile；用户自定义 profile 或持久会话
权限覆盖仍须独立验证，不能把环境变量当作绕过原生策略的万能开关。

Ask 下普通写入已被原生只读策略阻止；显式请求一次写权限时，host decline 后文件没有创建。
后端有时用 end_turn 正常描述“被拒绝，停止”；适配器现在记住真实权限拒绝，返回
uncertain/turn_failed、固定诊断 permission_denied，避免把这段解释误记为交付成功。
测试分别记录“只读自动阻止”和“用户收到审批并拒绝”，二者不混为同一证据。

## 验证与限制

本轮仍是生产 transport + 真实 CLI/提供商 + 隔离合成工作区，不覆盖完整桌面 UI、
durable Task 收口、Windows 真机、语音或安装包。原始材料在忽略的 `output/acp-fixes-20261011/`，
含私有认证副本，不能提交或公开上传。

- OpenCode、CodeBuddy：拒绝、运行中取消、崩溃后无迟到文件、无效凭据后同会话恢复均有通过记录。
- Pi：Ask 在写出前拒绝（不具备逐项审批）；取消、崩溃清理、结构化凭据错误与同会话恢复均有通过记录。
- DeepSeek：只读策略阻止写入、显式一次审批拒绝、运行中取消、崩溃清理及同会话凭据恢复均有通过记录。
- OpenCode/Qwen Flash 和 Pi/DeepSeek V4 Pro 恢复后新任务执行仍有上述波动；本记录不签它的模型稳定性，也不签 M9-C 整体验收。
- 新增回归先复现了已销毁 stdin 挂起、跨组工具残留、权限未映射和拒绝误报完成。
  额外真实进程测试覆盖多行环境与不误杀无关进程。
- 本地 Claude CLI + claude-sonnet-5-5 做了设计和实现两轮只读复核；已处理组终止顺序、迟到 EPIPE、
  多行环境、保留安全约束及原子补丁清理意见。另复核恢复补丁，修正成功重试后的错误边界、历史边界漂移、稳定消息 ID，并核查原生变量与快照实现。
  其未运行的推断没有当作验收证据。

本轮自动化：完整 runtime **3638 通过 / 0 失败 / 9 跳过**；ACP/进程归属/文档契约 **94/94**；
Pi 错误兼容补丁契约 **4/4**、恢复边界契约 **3/3**。类型检查、lint、环境契约和能力清单检查通过。
额外 OpenCode/Qwen3 Max 路由尝试收到 server_rejected（固定诊断 unclassified），
未获得有效执行证据，不把它列为本轮认证配置，也没有更改用户默认模型。
