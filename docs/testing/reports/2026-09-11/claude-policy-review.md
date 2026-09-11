# Claude policy review

Model: claude-fable-5-1 (confirmed by modelUsage). Code review hypotheses, not causal proof.

直接给结论，没有跑任何工具。

**失败一（追加要求只口头回复）— 具体冲突**

1. `runtime/src/realtime/frontend-instructions.ts` 的 CODING_INSTRUCTIONS_AFTER 里这一行是主因：
   > 用户修改需求时保留新约束，旧待确认事项不再有效。用户回答 Coding intake 的宿主问题后等待宿主规划，不重复 dispatch。

   "修改需求 → 保留新约束"只描述了内部状态，没说要调用什么；紧接着又是"不重复 dispatch"。"只改样式，不修改业务逻辑"正好被 qwen-flash 匹配成"修改需求 / 新约束"，于是走了"保留、不 dispatch"这条。这是它口头说"已收到"的直接来源。
2. 唯一明确禁止口头代替调用的那句（"用户要求执行、追加或取消时，直接提交对应工具调用…不要用收到请求、准备提交等口头回应代替调用"）埋在 AFTER 段末尾，前面隔着约 40 行 recall/status 规则。小模型没有把它和 CODING 段关联起来。工具描述再强也压不过系统提示里就近的"不 dispatch"。
3. 次要矛盾：AFTER 段要求 instruction "必须保留最终交付目标…描述完整任务"，而 BEFORE 段说"原样传这一轮的完整要求"。纯约束型追加满足不了"完整任务"，模型倾向不调用。

**失败二（先讨论却查记忆）— 具体冲突**

AFTER 段第一句：
> 用户询问历史任务…按需调用 memory__recall；…**当前上下文没有完整证据时，调用 memory__recall**。

分号后这半句丢掉了"历史"限定，成了无条件触发。"有什么好处"是任务讨论，上下文自然"没有完整证据"，于是 recall。而"用户要求先讨论时可以回应"用的是"可以"，只是许可，压不过前面的指令句。若该用例还关闭了搜索，"可以按需调用 memory__recall 查找历史线索…查询记忆后最终回答必须说明"又叠了一层 recall 倾向。

**最小修复（三处改写，不加路由、不动测试）**

```text
1. CODING_INSTRUCTIONS_AFTER 那行改为：
   '用户追加要求或修改约束时，仍调用 dispatch，instruction 只传这一轮的追加内容；旧待确认事项不再有效。'
   '只有在用户回答 Coding intake 的宿主提问之后，才等待宿主规划、不重复 dispatch。'

2. 把"用户要求执行、追加或取消时，直接提交对应工具调用…不要用收到请求…代替调用"
   这一句从 FRONTEND_INSTRUCTIONS_AFTER 移到 CODING_INSTRUCTIONS_BEFORE，
   紧跟"任何编程请求…都调用 dispatch"之后。

3. recall 开头改为：
   '用户询问已经发生的历史任务、先前观察或结果，且当前上下文没有证据时，才调用 memory__recall；'
   并把"用户要求先讨论时可以回应"改为
   '用户要求先讨论、评估方案或询问利弊时，直接口头回答，不调用任何工具。'
```

第 1、2 条针对追加要求，第 3 条针对讨论误查。都只是收窄已有句子的触发范围和调整位置，不改变确认/禁用能力那些已生效的规则。改后建议先跑 qwen-flash 上原来那 3 个失败用例加一个"回答 intake 提问"用例，确认没把"不重复 dispatch"误伤成重复派单。
