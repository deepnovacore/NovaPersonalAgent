# Independent review

Verified CLI modelUsage: `claude-fable-5-1`. This is reviewer analysis, not independently executed verification; consult the coordinator findings and raw evidence.

我按只读方式审阅了 runner、评分器、fixture、frontend prompt、两个 adapter 和两份合成基线。下面的结论都只基于这些材料，没有运行任何命令，也没有重新计算 fixture hash，所以凡是依赖“报告是否用的是修正后 fixture”的判断我都标成了条件结论。

## 总体判断

两份报告里最大的一块失败不是路由失败。Qwen 侧的 protocol 失败占了失败总数的一大半，而这些用例的观测是空的，没有任何一次模型决策被评分。Ark 侧的失败则大多能追到 prompt 缺陷或用例定义歧义，真正指向模型遵循能力的只有少数几项。同时评分器在 disabled 用例上放过了几组明显的幻觉式“假通过”，这比任何一项失败更值得先修。

| 用例 | Qwen | Ark | 我的归类 |
| --- | --- | --- | --- |
| search / session-memory / knowledge / vision-monitor / knowledge-injection | 0/3 protocol | 通过 | 无法判定，adapter 或流形状，非路由 |
| coding | 2/3，1 次 protocol | 3/3 | 同上 |
| confirm-yes / confirm-no | 1/3，0/3 | 3/3 | 模型遵循，附带一个上下文注入方式疑点 |
| confirm-ambiguous | 3/3 | 0/3 | prompt 自相矛盾加用例歧义 |
| coding-steer | 0/3 | 3/3 | 模型遵循为主，fixture 上下文不真实为次 |
| 四个 disabled 用例 | 全部“通过” | 大部分失败 | 评分器漏洞加 prompt 缺失，Qwen 的通过是假通过 |
| general-answer | 3/3 | 0/3 | prompt 未声明搜索策略 |
| snapshot | 3/3 | 2/3 | 工具描述边界，模型次之 |
| knowledge-failure | 0/3 | 3/3 | 模型把失败当空结果，条件成立时算模型缺陷 |
| personal-memory | 2/3 | 3/3 | schema 两个枚举可混淆，模型填错 |

## 逐项证据与最小实验

**1. Qwen 的 protocol 失败不能归因模型，但目前也无法归因 adapter。**
证据在报告：这几条 `reason: "protocol"` 的观测全是 `calls: []`、`text: ""`、`completed: false`，耗时都在半秒到七百毫秒之间，说明 DashScope 完整返回了响应，不是超时或网络问题。关键对照是 `knowledge` 与 `knowledge-failure`：两者调用的是同一个工具，参数形状也相同，后者三次都正常产生了 tool_call，前者三次都 protocol。`knowledge-injection` 同理。差别只在用户文本。所以这是一个受模型输出内容影响、被 adapter 拒绝的流形状问题，与“模型是否选对工具”无关。
在 `qwen-llm.ts` 里我能排除的路径：文本先于工具调用的路径会先 yield `text_delta`，runner 会记录到 `observed.text`，而报告里文本为空，所以“先说垫话再调工具”不是这几条的原因。剩下可能的抛点集中在工具调用组装阶段，因为 `tool_call` 事件要等 `#calls` 成功后才 yield，任何一处失败都会留下空观测：
- `#fragment` 里 `index !== 0` 直接抛，即并行第二个调用即使设置了 `parallel_tool_calls: false` 也会被判 protocol。
- `#calls` 里参数 JSON 解析失败、name 为空、fragments 数量不为一都抛同一个码。
- `finish_reason` 为 `stop` 但已有 fragments，或出现 `stop`/`tool_calls` 以外的值，也抛同一个码。
整个 adapter 大约二十处 `fail('protocol')` 共用一个码，报告又刻意不保存传输细节，所以当前产物对这类失败零可诊断性。
最小实验：给每个 `fail('protocol')` 加一个 detail 子码并写进报告的 `reason`，然后只对 `search` 这一条用相同 body 直接请求 DashScope 并保存原始 SSE，与 `knowledge-failure` 的原始流对比。这一步之前，Qwen 报告里关于搜索、会话记忆、知识库、视觉监控的路由结论应视为“无数据”，而不是失败或通过。另外 runner 把 protocol 归入 `failed` 与行为失败同列，建议在 caseSummary 里单列一栏，不改通过标准，只改分类。

**2. disabled 用例的评分是漏的，Qwen 的通过是假通过。**
证据在报告：Qwen 的 `camera-disabled` 三次都说“我正在查看摄像头前的情况”，`knowledge-disabled` 说“请稍等，我马上为你检索”，Ark 的 `search-disabled` 第三次说“我这就提交搜索请求”，`coding-disabled` 说“我准备提交修改登录页代码的任务”。这些都是在没有任何可用工具的情况下声称正在执行动作，直接违反 prompt 里“没有工具事件或 host 事实时，不得声称已经提交、已经启动”那一行，但 fixture 只要求 `text: required`，全部记为通过。
prompt 侧的根因在 `frontend-instructions.ts`：模块被禁用时只是删掉对应指令段，从未告诉模型这些能力不存在。留下的记忆相关指令又反复要求“先调用 memory__recall”，所以 Ark 在四个 disabled 用例里去查记忆是被 prompt 推着走的，不是模型胡乱调用。
最小实验：先只改 fixture，给四个 disabled 用例加 `textAny` 要求出现“无法/不支持/未接入/暂不”一类词，加 `textNot` 禁止“正在/马上/这就/准备提交”，重跑一次看 Qwen 从 12/12 掉到多少。再在 prompt 里对禁用模块加一句能力不可用声明，重跑对比 Ark 的 memory__recall 调用是否消失。两步分开做，才能区分评分器问题和 prompt 问题。

**3. confirm-ambiguous 的失败是 prompt 自相矛盾，不是 Ark 的缺陷。**
证据在 `frontend-instructions.ts` 的 HOST_CONFIRM_INSTRUCTIONS 和 `work-tools.ts` 的 confirm 描述：两处都写“拒绝、取消或暂缓 accepted=false”，紧接着又写“语义不明确时不要调用”。用户说“我还没想好”，读成暂缓完全合理，Ark 三次都稳定给出 `accepted: false`，这是对现有 prompt 的一种自洽执行。只有编程审批那段 CODEX_APPROVAL_INSTRUCTIONS 明确写了“尚未决定时不得调用”，而这段在项目确认场景下根本没有启用。
这也牵涉产品语义：accepted=false 会让宿主取消提案，用户的“没想好”被当成了拒绝。这是需要人定的规则，不该靠评分器裁决。
最小实验：只对 Ark 跑三个变体，“我还没想好”、“先等等，暂时别建”、“这个 demo 项目是做什么的”。如果前两个都调 confirm false、第三个不调，说明模型在按“暂缓”桶执行，问题在 prompt 定义。修法是把暂缓限定为用户明确要求推后，并把“尚未决定不调用”的表述从审批段提升到通用确认段，然后重跑。不要改 fixture 期望去迁就现状。

**4. confirm-yes/no 与 coding-steer 在 Qwen 上是模型遵循问题，但 fixture 有一处不真实。**
证据在报告：Qwen 对“不，取消这次操作”回复“已取消新建 demo 项目的操作”，第三次还朗读了 id；对“同意，继续”回复“已确认，正在为您新建”。这些既没调 confirm，又声称动作已发生，两条明确禁令同时违反。同一输入 Ark 六次全对，Qwen 的 confirm-yes 第一次也对了，说明 prompt 本身可被遵循，不稳定的是 qwen-flash。coding-steer 的三次回复逐字相同，“这个约束会纳入当前任务的执行范围”，同样是无工具事件下的虚假承诺。
不真实之处：coding-steer 的 context 里没有任何 `active_executor_context`，模型看不到有任务在跑。prompt 说追加要求也走 dispatch，所以按规则仍该调用，失败可以计入，但这不是生产中的典型形态。confirm 用例的另一个疑点是宿主事实通过 `workspaceContext` 拼进了 system 消息，prompt 里描述的确是系统角色注入，但是否与生产中宿主事实的注入位置一致，从给出的代码看不出来。
最小实验：coding-steer 改成两步，第一步 coding dispatch，第二步用合成的 running 状态 `active_executor_context` 再追加要求；同时把 confirm 用例换到 qwen-plus 跑三次。前者区分上下文与模型，后者区分模型规模与 prompt。

**5. Ark 在 general-answer 上调搜索，是 prompt 没有声明策略。**
证据在报告与 prompt：SEARCH_INSTRUCTIONS 只写了怎样使用结果，全文没有任何一句说常识问题不要搜索。fixture 却把“天空为什么是蓝色”定义为零调用，这是一个 prompt 里不存在的产品决策。Doubao 系模型倾向搜索是已知风格，但在无策略声明的情况下不能算违规。
最小实验：在 SEARCH_INSTRUCTIONS 加一句“稳定常识直接回答，只有时效性或不确定信息才搜索”，重跑 Ark 三次。若仍搜索再考虑归入模型。

**6. 评分器放过了搜索 query 里的日期幻觉。**
证据在报告：Ark 的 `search` 两次通过时 query 是“2024年10月12日航天新闻”和“2025年6月19日航天新闻”，而运行日期是 2026 年 9 月。模型在没有日期上下文的情况下编了日期，生产里这会拉回错误结果。fixture 只检查包含“航天”，评分器没有参数级反向断言。
这一半是 prompt 或上下文缺陷，生产 context 里没有当前日期；一半是评分器盲区。建议 `score` 增加参数级 `notMatch` 正则检查，fixture 对 query 禁止四位年份，同时在生产 context 加当前日期后重跑。

**7. memory 的 scope 与 source 确实可混淆，但目前只造成一次无效参数。**
证据在报告与 `tool-schema.ts`：Qwen personal-memory 第一次给了 `scope: "personal"`，枚举里没有这个值。Ark 在三次 disabled 调用里直接省略了 source。两个参数都在描述“到哪里找”，只是维度不同，描述文字没有把“时间范围”和“记忆来源”区分开。注意 Qwen 的 session-memory 三次全是 protocol，所以 Qwen 侧对 session 来源的选择完全没有观测。
还有一个评分器细节需要核实：`z.fromJSONSchema` 会把 schema 里的 `default: "session"` 填进解析结果，所以模型省略 source 时评分按 session 通过。这是否与生产宿主处理省略的方式一致，从给出的代码看不出来。若生产不填默认值，评分器就比生产宽松。
最小实验：只改两个 description，scope 明写“时间范围”，source 明写“记忆来源”，重跑 personal-memory 与 session-memory 各三次。这会动到被 golden 钉住的 schema，按文档要求需要复审受影响的路由用例。

**8. knowledge-failure 在 Qwen 上把失败说成了没找到，条件成立时算模型缺陷。**
证据在报告：结果是 `state: "failed"`，Qwen 三次都回答“没有找到相关记录”，还推测“可能手册未导入”，违反“失败时如实说明，不猜测”的指令；Ark 三次都正确说不可用。但我没有工具，无法确认这两份报告的 `fixtureHash` 是否对应修正后的 fixture。按你的说明，凡是旧形状下的续答结论一律不算，这一条只有在 hash 与当前文件一致时才成立。另外合成错误只给了内部枚举 `knowledge_mcp_invalid_result`，模型没有关于 state 字段语义的任何说明，若生产返回就是这样，prompt 里应补一句解释。

**9. snapshot 在 Ark 上一次走了 dispatch vision。**
VISION_INSTRUCTIONS 只说监控走 dispatch，没有说一次性查看走 snapshot，边界靠两个工具的 description 自然区分。这两个 description 不在给出的材料里，无法进一步判断。建议先读 CAMERA_MCP_MANIFEST 与 VISION_AGENT_DESCRIPTOR 的摘要，若有重叠再加一句区分。

**10. 两个结构性风险，未直接导致本次失败，但影响解读。**
- 两个 adapter 都把“文本与工具调用同时出现”判为 protocol。Qwen 在 `finish_reason` 为 tool_calls 且 `sawText` 时抛，Ark 在 tool_call 之后收到 text_delta 或反过来时抛。这意味着生产里模型只要先说一句“好的我来查”再调工具，整个响应就失败，这类行为在评分层面永远不可观测。这是设计选择还是缺陷需要你定，但它确实让 `text: forbidden` 断言在有调用的用例里只是形式存在。
- Qwen 多个用例三次重复输出逐字相同，包括 coding-steer 的回复和 search-disabled 的参数。三次重复在这种确定性下对稳定性的证明力很弱，caseSummary 的 accepted 不应被读成“三次独立采样”。

## 建议的执行顺序

1. 给 protocol 加子码并抓一条失败用例的原始 SSE，这是唯一能把 Qwen 报告的一半失败从“未知”移出的动作。
2. 收紧四个 disabled 用例的文本断言，然后再补 prompt 的能力不可用声明，分两次跑。
3. 统一 confirm 里“暂缓”与“不明确”的定义，用三个变体验证后重跑。
4. 给 SEARCH_INSTRUCTIONS 加常识不搜索策略，给 context 加当前日期，给评分器加参数级反向断言。
5. 以上都稳定后再看 qwen-flash 在 confirm、coding-steer、knowledge-failure 上的遵循能力，届时剩下的失败才是可以放心归入模型的部分。
