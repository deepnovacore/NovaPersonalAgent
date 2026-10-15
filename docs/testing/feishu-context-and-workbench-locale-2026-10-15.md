# 飞书会话检索与工作台语言修复验证

基线：`17408553145434a09b1ec69e761d52f3f1265145`。

## 问题与改动

主会话的统一检索原先只合并抽取后的记忆和知识库索引，尚未抽取为记忆的 IM 原文无法直接成为候选。Profile 生成、消息发送和主会话检索是不同路径，前两者可用并不能证明第三条路径完整。

- 增加已同步沟通原文的只读检索，复用来源有效性、保留期和实际模型消费者的处理授权校验；消息编辑后旧版本不再可读。
- `memory__recall.source_filter` 支持来源类型、提供方及时间范围。`last_days` 由运行时计算；指定过滤条件时不以项目文件或推断记忆替代消息。候选窗口达到上限时明确返回 `degraded`。
- 原文候选默认覆盖 IM、邮件和日历；文件继续走既有知识库索引，仅在明确指定文件来源时扫描原文，避免大量文件挤占消息候选。
- 工具与提示词明确区分未检索到、检索不可用和平台授权状态，结果保留证据引用和时间。旧版无提供方元数据的飞书记录兼容其来源定位符。
- 工作台标签、状态、显示模式、主对话输入区和无障碍标签统一跟随语言设置；用户消息与自定义标题保留原文。

## 验证

- Runtime 编译、完整 ESLint：通过。
- 检索集成、统一检索、实时工具桥接、工具协议、Qwen 握手和定时工具测试：50 项通过。集成测试使用真实临时 SQLite，覆盖未抽取原文、来源/日期过滤、旧版记录、修改后旧证据失效、授权撤销和未授权消费者。
- 桌面完整构建：通过；桌面测试 1,298 项通过、3 项跳过。
- CLI：31 项通过；server CLI：4 项通过。
- 使用实际工作台渲染模块和虚构数据，在浏览器核对中英文标签与输入区；这不是飞书同步或真实模型端到端验收。
- Windows source-startup smoke 在本次 macOS 环境按脚本约定跳过。

完整 runtime 首轮运行 3,823 项，其中 3,791 项通过、22 项失败、1 项取消、9 项跳过。更新本次新增行为的两处协议基准并串行复跑失败文件后，启动/连接等超时不再复现；剩余以下三项在未修改的主工作区也以相同断言失败：

1. `daily-brief-host.test.ts`：task completion preserves its originating topic card and updates one topic result。
2. `personal-conversations.test.ts`：a hidden schedule conversation is absent from the conversation list and the main projection。
3. `task-dispatch.test.ts`：verified completion publication is idempotent and does not repopulate a cleared transcript。

## 验收边界

本次完成代码修复与本地回归，未执行真实飞书 OAuth 重连、外部消息发送或真实模型端到端验收。采集连接断开时，修复只使仍有效且获授权的历史原文可检索，不会自动补齐最近消息；恢复连接并同步后，仍需在实际主会话验证工具调用及引用。
