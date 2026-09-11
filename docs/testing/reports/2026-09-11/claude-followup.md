# Independent review

Verified CLI modelUsage: `claude-fable-5-1`. This is reviewer analysis, not independently executed verification; consult the coordinator findings and raw evidence.

**结论先行**：null 尾包和知识库 envelope 两项归因成立；Ark 三条对照改法有两条属于刷分；Qwen coding-steer 是真实缺陷但有 case 放大；scorer 和 hash 各有一个漏洞。

**归因漏洞**
- **surfaceHash 失真**：focused-rule 与 running-context 的 hash 相同，说明 hash 只取 `frontendInstructions(modules)`，覆盖 instructions 未入 hash。对照记录无法证明用了哪份 prompt，先修。
- **样本量**：3 次区分不了 0/3 与 1/3，0/3 与 3/3 也只是"未见反例"。至少 5–10 次，且不要同时改 case 文本和 prompt。
- **`contains` 字面匹配**：focused-rule 两次失败是"只修改样式"不含"只改样式"，模型语义完整。真实结果是路由 3/3、字面 1/3，归因为"极简规则也只 1/3"是错的。
- **通过用例文本未审**：confirm-ambiguous 第 2 次编造"帮你询问负责人"，knowledge-failure 三次都猜"文档未导入"，违反"不猜测文档内容"，却因只计 call_count 而通过。
- **coding-steer 的 text=forbidden 与生产 prompt 冲突**：生产允许口头"收到请求、准备提交"再 dispatch。应改为 textNot 禁止"已收到/会确保/正在更新"等承诺词，而不是禁止全部文本。

**哪些是刷分**
- general-answer 加"不要联网搜索"：把默认路由题改成了指令遵循题。原 case 若意图是"常识题不搜"，Ark 搜索是产品策略未定义而非模型弱；应二选一：接受"搜一次再答"为合格，或在生产 prompt 定义策略。改用户文本是最差选项。
- search-disabled 加"不要查历史记忆"：能力提问被路由到 memory__recall 是真实误路由，改法直接移除了被测行为。保留原文本，把 recall 计为单独统计的软失败即可。
- confirm-ambiguous 新文本"我在问原因，没有作出同意或拒绝的决定"不是真实语句。根因在生产 prompt：HOST_CONFIRM 说"暂缓→false"，CONFIRM_TOOL_SPEC 说"含糊不调用"，"还没想好"两条都能套。先修 prompt 再用自然文本（"让我再想想"）测。

**应改生产 prompt 的**
- 明确"暂缓（先不做、以后再说）=false；未决定（还没想好、想问原因）不调用并追问"。
- coding-steer：加"任务运行中的追加要求同样 dispatch，不得口头承诺已纳入"。running-context 0/3 的失败形态（"我会确保…"）在生产里会让用户误以为已生效，这是真实危害，不是测试倾斜。
- confirm-no 极简 3/3 只证明规则可学；生产 prompt 失败则说明是规则被冲突条款淹没，靠改 case 无解。

**真实模型遵循缺陷**
- Qwen 在完整 prompt 下追加约束不调用 dispatch 并虚假承诺：真实缺陷，但需先排除 context 形状与 `activeExecutorContextData` 输出是否一致。
- Ark 能力提问误调 recall：真实但轻微，且 prompt 中"没有完整证据时调用 recall"本身在推波助澜。
- Ark 常识题搜索：不是缺陷，是策略缺失。

**限制**：以上均基于合成 tool_result 与文本输入，语音 ASR 噪声下的路由未覆盖；null-only 拒绝是正确行为，但需确认修复只在已有完整 string 后忽略 null，避免把截断参数当完整。
