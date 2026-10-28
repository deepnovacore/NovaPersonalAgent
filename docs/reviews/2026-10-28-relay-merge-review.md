# relay 合入 v1.0.0dev 审查记录（2026-10-28）

## 目标与范围

- 初始目标基线：`6d9532d57d88587e461cb0dae44036eeda81a55d`（v1.0.0dev，保留最新 React 桌面及移动端改动）。
- 来源：`80b613843ce3be96c29be3843c0886e498bd3dad`（原 v1.1.0dev，现本地 relay）。共同祖先 `b02ff8c8339fcd901499b80e7f221bb51710f0c8`；来源侧独有 71 个提交，385 个差异文件。
- 远程改名：只有 fork 存在旧分支。已原子将 `fork/v1.1.0dev` 改为 `fork/relay`，保留原远程提交 `5652030ed755512e7d464866205b9229f27f2bab`；没有把本地领先提交借改名上传。origin 没有旧分支。
- 收尾时主分支新增 `ae97610d4715d7d24be2e896b30746e40ce831b8`（关于我资料展示与文案修复）；5 个文件已三方干净合入，并重新运行 React 全套与渲染检查。最终合并第一父提交采用这个最新目标。
- 不合入 internal，不推送 v1.0.0dev，不发布或部署。原主工作区的未提交修改与未跟踪文件单独保留。
- 审查假设：单个固定 Host、少量配对设备；不把本地测试结果扩大为公网服务、真实手机、系统推送或真实模型验收。

## 合入前 review

两位独立 reviewer 分别追踪 Relay/Push/Host 的安全、持久化和旧 Hub 退役，以及 Flutter Space 隔离、原始数据保留、原生权限和 UI 交集；主审查覆盖桌面 IPC、React 设置页和冲突调用链。

1. **P1：旧共享定时任务使升级后的 Host 无法启动。** 新 persisted schema 严格拒绝旧 `shared:{owner_revision:1}`。用旧有效任务文件复现 ZodError。修复保留 shared 标记、任务定义和运行历史，打开时归档并禁用旧共享项，activeRuns 不接管其执行；普通定时任务继续工作。回归验证不能手动执行或自动领取旧共享项。
2. **P1：合法长聊天消息无法通过加密传输。** Host/Client 允许 16,000 字符，签名加密后 16,000 ASCII 为 80,744 字节、6,000 汉字为 90,620 字节，均超旧 64 KiB stream 限制。真实加密复现 `message_too_large`。将 bounded stream 上限调至 512 KiB，SDK WebSocket 帧预算同步覆盖；队列 1 MiB 总预算保持。回归通过真实 HTTP 和 WebSocket 发送最大 ASCII、汉字和 JSON 转义字符。
3. **合并集成：旧 Hub 的 React 入口会失效。** 来源删除 Hub/phone IPC，目标 React 设置仍引用。将 Space 状态、配对码/二维码、手工指纹核对及双步撤销接入既有 Card/Field/Action，移除旧入口；旧 hub/phone deep link 转到连接器页。保留最新模型设置、权限、工作区、审批、记忆连续性及 extraction 配置修复。不会恢复已移除的 enter_plan_mode。

合入前独立编译通过；Relay/Push/Space 测试 122/122，加本地 loopback Host→gateway/provider boundary 验证。回归测试先确认旧代码失败，再检查修复。

## 合入后 review

- 两位 reviewer 对照双方父提交复核实际候选，未发现新的确定阻断问题。修复后的升级回归与最大聊天真实传输由 reviewer 独立重跑通过。
- Flutter 保留 SpaceRoot、私有存储路径与 publication API，同时保留目标的头像、定时任务导航及展示；pubspec/Info.plist 合并双方内容。旧独立数据不自动导入新 Space，也没有删除旧文件。
- 主审查发现旧 CSS hover/active 会覆盖 Radix 背景，造成新确认按钮白底白字；两条旧规则排除 .rt-Button，让组件自身处理状态。浏览器重新核对交互及可读性。
- CI 的活动分支过滤改为 relay；历史设计/验收文档中的旧分支名作为历史记录保留。
- 更新旧测试仍依赖文字 Settings/旧手机插图及打包 fixture 的假设；没有为使测试通过改变产品的设置入口。

## 验证证据

所有编译、测试输出位于外置 APFS 本轮目录，未清理或写入主工作区共享 dist：
`/Volumes/sqxh-junjie/nova-builds/relay-ec386f7dc50a-01a18264/`。

- Space stack（relay、push-gateway、runtime）编译通过；React renderer 类型检查与构建通过。
- 最终 Relay/Push/Space 测试 123/123；loopback 端到端链路、重复请求和撤销通过。
- 桌面 Node 全量 1,677 通过，13 跳过，0 失败。React 11 个文件、123 项全部通过。
- runtime 首轮全量 4,031 通过、167 失败、11 跳过；多数失败为外置编译包缺少相对 fixtures 或脚本路径。补齐只读测试路径后，失败文件复跑 1,332 通过、3 失败、1 跳过、5 todo；余下 MCP 3 项同为 SDK fixture 路径，修复测试布局后该文件 21/21。独立完整 transport 109/109。早期一次 transport_lost 未定位根因，最终定向及全文件复跑通过，相关生产源码与目标基线完全相同。该过程不等同于一轮全绿的全量运行。
- CLI 与 server-cli 合计 39/39；包括离线安装打包 server 并解析 relay crypto exports。
- Flutter analysis 无问题。最终全量 1,012 通过、3 跳过，仅两张 golden 差异导致该文件失败；目视核对并更新后，普通 golden 比较和导航相关 8/8 通过。本地 Dart↔Relay 及 Gateway 验证在全量中启用。
- Playwright 使用合成数据和真正浏览器检查错误指纹拒绝、匹配指纹绑定及撤销确认；13 个设置类别，无 page error 或水平溢出。截图及结果在 `output/playwright/`。这不是 Electron 原始用户数据或真实手机验收。
- 最终 runtime lint、类型检查通过；schedule 7/7，环境/能力契约通过。`git -c core.whitespace=-blank-at-eol diff --cached --check` 通过（保留历史 Markdown 两空格换行）。

## 截图与发布边界

更新的 Flutter goldens 只有通用控件和合成数据，已经目视核对；不据此代替项目所有者的发布审阅。两文件的本轮版本：

| 文件 | SHA-256 |
| --- | --- |
| chat-home.png | cade9b35341ebef21deffda4defdde8507fb2ccca5b4d4a4d78c3b4fc00b34ca |
| chat-settings.png | b75ef8d4a63cda6f38e1b634288562d56377a6fdddb6872ffa9e2b5555c4fa78 |

沿用 ASSET_PUBLICATION 的逐版本审阅边界；本次仅本地合并，不推送这些截图。其他已批准字符资源未改动。

## 保留的限制

- 没有真实手机、APNs/FCM/MiPush、公网部署、真实 Codex/模型调用或原始用户数据的 Electron 验收。
- Relay ACK 不自动回收 mailbox 历史容量；既有 bounded retention/fail-closed 限制仍在，不能据本地测试认定无限期运营可用。
- 延续目标 Chat 的工具权限，普通 Chat 不获得 mobile__action 执行权限；桌面 Space RPC 仍可用。没有通过合并绕过原权限政策。
- 远程 relay 与本地 relay 原本就不同步；改名保持各自原提交。
