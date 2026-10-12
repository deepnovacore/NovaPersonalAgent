# Windows ACP 安装、登录与异常路径验收：2026-10-11

验收源码为 `v0.4.0dev` 的 `ea1c2a24713de7b7aa993562be2b16c6c177f027`。
Windows Server 2022 x64，Node 24.20.0、npm 11.19.0；使用新隔离目录，没有覆盖现有项目。
结论：四个后端安装、登录和独立模型调用成功，但 **Windows ACP 整体未验收通过（修复前）**。

## 安装与登录

| 包 | 安装版本 | 原生调用 |
|---|---|---|
| opencode-ai | 1.19.0 | DashScope 返回预期回复 |
| @tencent-ai/codebuddy-code | 2.164.0 | 用户完成原生网页登录；Hy4 Preview 返回预期回复 |
| pi-acp / @earendil-works/pi-coding-agent | 0.0.34 / 1.1.0 | DeepSeek 返回预期回复；原生 auth check 为 ready |
| @deepseek-ai/dsh | 0.2.0-rc.2 | headless 返回预期回复 |

仅配置必要的 API 凭据，目录 ACL 限制为 Administrator 和 SYSTEM；没有公开上传密钥或原生会话。
Pi ACP 错误补丁、Pi 实际 bundle/SDK 恢复补丁、DeepSeek 恢复补丁均通过原始哈希核查后应用。
OpenCode 恢复插件已安装；安装时显式把原生 opencode.exe 所在目录加入 PATH。
npm 11.19.0 默认未运行部分安装脚本；补跑 OpenCode postinstall 和 DSH subprocess spawn-helper 准备步骤。
Pi 的初次调用超过探测时限，明确 provider/model 后独立调用成功，未把超时计入成功。

## 默认启动缺陷

生产 AcpTransport 配合原生 Windows Job Object guardian 时，四个后端默认启动均返回
`preflight_failed`。guardian 要求原生可执行文件；默认命令名/npm 脚本入口不能直接满足该要求。
应在宿主解析、校验原生 executable 与固定 argv；不能降低 guardian 的原生路径/PE 校验来绕过。
本轮没有修改生产启动逻辑，桌面默认流程仍不可判通过。

后续异常路径实跑由验收宿主显式指定已安装的原生 OpenCode executable，或固定 npm 入口经
node.exe 启动，再交给同一个生产 guardian。它验证真实 transport、提供商、原生子进程和会话，
**不证明桌面默认发现/启动已经修复，也不替代 Nova Task/产物闭环**。
验收脚本和原始报告保存在忽略的私有 `output/acp-windows-20261011/`；未纳入发布 runtime。

## 真实异常路径

| 后端 | 拒绝 | 取消 / 崩溃 | 凭据失败 | 同会话恢复 |
|---|---|---|---|---|
| OpenCode | 原生 edit/bash ask 复测通过 | 通过 | 通过 | 随机文件内容、同一 session、进程清理均通过 |
| CodeBuddy | 通过 | 通过 | 通过 | **失败：仍回复旧 AUTH_OK，没有新文件** |
| Pi | Ask 不支持，派发前明确拒绝 | 补齐现有 Git Bash 后分别通过 | 通过 | 随机文件内容、同一 session、进程清理均通过 |
| DeepSeek Harness | 通过 | 通过 | 通过 | 随机文件内容、同一 session、进程清理均通过 |

- OpenCode 初次拒绝用例返回模型文字拒绝，没有权限请求、没有文件，transport 标为 completed；严格判失败。
  独立复测在隔离配置中明确设置 edit/bash ask 后，真实请求权限被拒绝，返回 turn_failed / permission_denied。
  这不代表 Nova Ask 自动强制配置了所有原生后端的权限策略。
- Pi 初次取消/崩溃用例没有启动目标命令，原因是原生 shell 未配置；不能用“没有晚写文件”冒充进程取消通过。
  指定已安装的 Git Bash shellPath，并让隔离配置保留此设置后，两项均确认目标命令已启动，
  触发取消/杀死 owner 后等待 16 秒，无晚写产物且 Job 完全清空。
- CodeBuddy 恢复保持原 session，却回复旧 AUTH_OK；首次及后续独立复测的失败记录保留。
  此处没有用切换新 session、覆盖原生日志或只检查协议 completed 来冒充恢复成功。

## 自动化与边界

Windows 原生 guardian 实机行为 **2/2**，runtime guardian 协议/PE 校验 **6/6**；
恢复补丁及插件契约 **13 通过 / 0 失败 / 1 平台跳过**，包括 Windows 实际 Pi bundle。
没有在 Windows 重新编译整个 TypeScript runtime；使用上述 SHA 已构建的 JS，原生 guardian 在 Windows 编译。
本轮不包含完整桌面 UI、语音、安装包、签名、升级或 GUI 执行验收。

后续已修复默认启动及 Windows CodeBuddy 旧回复问题，生产默认路径 20/20 场景通过，见 [Windows 修复复验](acp-windows-fixes-2026-10-11.md)。本文件保留修复前失败证据。
