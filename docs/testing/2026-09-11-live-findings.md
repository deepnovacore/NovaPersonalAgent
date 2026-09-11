# 2026-09-11：工具调用 live 验收归因

> 以下是早期诊断记录；生产提示修复、Max 对照与最新评分见 [后续修复报告](2026-09-11-policy-fixes.md)。下文“尚未修改”的描述指早期批次。

结论：失败混合了生产解析 bug、测试错误、产品规则歧义和模型在完整 prompt 下的遵循不稳定，不能直接把总通过率叫作模型能力分。本次只修复确定的解析与测试问题，没有修改生产 frontend prompt，也没有用更容易的对照问题替换原始用例。

代码在 `feature/live-tool-acceptance` 独立 worktree。统一使用真实 cascaded LLM adapter、生产 prompt 和生产 manifest 编译工具；业务工具均不实际执行。语音、宿主确认 FSM、真实 Codex/摄像头执行不在本轮验收结论内。

## 1. 已证实并修复的生产 bug

Qwen 的工具流有时在完整 JSON 后追加如下空增量：

```json
{"function":{"arguments":null},"index":0,"id":"","type":"function"}
```

随后正常发送 `finish_reason: "tool_calls"`。搜索、会话记忆、知识库、监控的抓包均显示：工具名和参数已经正确，故障发生在生产 `qwen-llm.ts` 的 `#fragment`，它把 null 当成非法非字符串并提前丢弃整个调用。

修复仅让 null 增量贡献零字节。最终仍必须有有效名称、call ID、完整 JSON object 和正常终态；null-only 不会变成 `{}`。真实响应已脱敏为固定 ID，收入 [回放 fixture](../../fixtures/realtime/qwen/v1/tool-null-delta.json)，对应测试明确验证修复前失败、修复后通过及 null-only 拒绝。

证据：[原始合成 SSE](reports/2026-09-11/provider-streams.json)、[修复前 Qwen](reports/2026-09-11/qwen-before.json)、[修复解析与 envelope 后](reports/2026-09-11/qwen-after-parser.json)。修复前 66 次中有 16 次 protocol 失败；后续 66 次没有 protocol 失败。跨轮次存在采样差异，因果证明来自同一响应的离线回放，不能把所有分数变化都算作修复收益。

## 2. 已修复的测试问题

| 问题 | 证据 | 修正 |
| --- | --- | --- |
| 知识库合成返回结构错误 | 原来用 `results/error`，生产宿主用 `{state, content}`，命中在 `content.hits` | 修正三个知识库续答 fixture，并用真实 in-process `KnowledgeMcpAdapter` 的合成 backend 离线核对 handoff |
| 字面匹配误当语义丢失 | “只修改样式，不修改业务逻辑”不包含原字符串“只改样式” | 加入人工审核的等义表达组；仍拒绝丢失“不改业务逻辑”的指令 |
| 禁用工具的假通过 | 没有任何调用，却回复“我正在查看摄像头”“马上为你检索”；旧评分只看文本非空 | 要求表达不可用，并拒绝已观察到的假执行承诺 |
| 搜索参数假通过 | Ark 把“今天”改成 `2024年10月12日` 或 `2025年6月19日`，却因包含“航天”通过 | 此 fixture 未提供当前日期，因此禁止 query 凭空添加绝对年份；相对时间仍可用 |
| 报告不足以重建未提交 fixture | 只有 hash，没有当时的完整用例 | 新报告保存选中 fixture 快照；保留旧报告，注明其局限 |

知识库失败场景在修正 envelope 的单变量对照中 Qwen 3/3 正确表达检索失败。这推翻了原先根据错误 mock 得出的“模型把失败说成空结果”归因。短回答的关键词判定仍不是通用事实裁判；例如额外猜测故障原因、不同措辞均需人工审阅，不能用一个关键词证明整段回复完全正确。

## 3. 不能直接判为模型弱的用例

- **普通常识题搜索**：生产 prompt 没有定义“常识必须零搜索”。Ark 搜索天空颜色的原理不构成违反已声明规则。诊断对照加“不要联网”后 3/3 不搜索，只证明能遵守显式限制，不能替代默认行为题。
- **“我还没想好”**：当前通用确认规则同时写“暂缓 → accepted=false”和“含糊不调用”；权限审批另有“尚未决定不调用”。Ark 稳定选择 false 是一种可解释的规则解读。应统一未决定与明确暂缓的语义，而不是直接认定危险误授权。
- **能力关闭后查询记忆**：旧用例要求零调用，但默认 fallback 策略不够明确。是否允许找历史线索与是否假称当前执行成功应分开判断。对照加“不要查历史”后 3/3 正确，不能以此替换原题刷分。
- **一次查看 versus 监控**：Ark 三轮中一次把 snapshot 选为 `dispatch(vision)`。需要明确一次性观察与持续监控的工具边界；这是一项真实选择不稳定，但样本不足以定位到模型规模或描述歧义中的单一因素。

原始问题仍保留在 fixture 中。上述策略探针的严格失败需要解释，不是已获产品裁决的模型缺陷。

## 4. 仍然存在的生产 prompt × 模型可靠性问题

### Qwen 追加约束只口头回应

用户输入：`给正在做的任务追加要求：只改样式，不修改业务逻辑。`

完整生产 prompt 下多轮仅回复“这个约束会纳入当前任务的执行范围”，没有 `dispatch`。最初 fixture 缺少 running state；随后改用生产 `renderActiveExecutorContext` 生成真实结构，三次仍未调用。因此不能只归因于 missing context。

只保留相关的短规则后，三次都选择了 `dispatch(codex)`。旧字面评分把其中两次误判为失败，实际路由是 3/3。结论是：模型具备调用能力，但在当前完整指令组合下不可靠；应优先排查规则竞争、响应类型划分和提示组织，而非直接认定它“不会工具调用”。三次小样本不是能力上限或统计显著性的证明。

### Qwen 明确确认只口头执行

用户明确同意/拒绝时，完整 prompt 下仍出现“已确认，正在新建”“正在取消操作”，但没有 `confirm`。这是可观察的指令遵循失败和假执行承诺。聚焦确认规则的对照中，明确拒绝三次均正确调用。结果同样指向完整 prompt 下的可靠性，而不证明某一条新 prompt 已可发布。

### 参数枚举混淆

个人记忆有时返回 `scope: "personal"`，schema 只允许 `recent|any`，`personal` 属于 `source`。这是实际无效参数，不是 host 执行故障。可以试验更清楚的两个维度描述，但本轮没有修改生产 schema 来迎合样本。

### 尚未解释的结构性契约风险

生产 prompt 允许某些非同步任务先口头接单，而两个 cascaded adapter 拒绝同一响应混合文本和工具调用。这是需要统一的跨层约定；本次捕获的 null 故障没有混合文本，不能拿它解释本次 protocol 根因。此外 prompt 中保留了 status fallback 指令，但 Codex status 已不直接暴露，应单独审视无状态证据时的可执行路径。

## 5. Claude 独立复核与对照实验

通过本地 Claude CLI 两次调用了用户指定的 `claude-fable-5-1`；返回的 `modelUsage` 确认了实际模型名称。传入的是选定公开代码、文档和合成测试记录，没有凭据。Claude 未执行工具，其文字属于评审意见；数字和代码判断已由本地证据复核。

- [第一轮完整评审](reports/2026-09-11/claude-review.md)
- [第二轮新证据复核](reports/2026-09-11/claude-followup.md)
- [单变量诊断对照](reports/2026-09-11/ablations.json)
- [生产运行上下文对照](reports/2026-09-11/running-context.json)

评审提醒了两个需要保留的限制：对照实验的 `surfaceHash` 是基础生产接口哈希，不包含 factoryOverride 的 prompt；真实覆盖提示已单独记录在 `experiment.instructions`，不能只拿这个 hash 声称 prompt 相同。三次重复也不能当作充分独立的统计证据。后续扩大评测时应固定独立 holdout 并记录有效提示和上下文哈希。

## 6. 如何读分数与后续工作

| 记录 | 结果 | 解释 |
| --- | --- | --- |
| Qwen 原始三轮 | 35/66 | 含解析 bug、错误 mock、评分漏检 |
| Ark 原始三轮 | 49/66 | 含策略歧义、评分漏检；不能直接与最终规则比较 |
| Qwen 修解析 / envelope 三轮 | 48/66 | protocol 清零，但旧评分仍有假通过与字面误判 |
| Qwen 最终评分单轮 | 14/22 | [完整最新报告](reports/2026-09-11/qwen-reviewed.json)；更严格的假承诺检查使部分“通过”转失败 |
| Coordinator 独立套件 | process passed | 沿用其 8/10 dev、7/10 holdout 门槛，不等于 100% 分类正确 |

最新失败是 `vision-cancel`、`coding-steer`、`confirm-yes`、`confirm-no` 和四个 disabled case。前四个没发预期调用；camera/knowledge disabled 出现假执行承诺；search disabled 走记忆；coding disabled 继续追问，没有清楚说明能力限制，属于严格边界检查，不能简单等同已执行幻觉。

工程检查：`npm run check`、离线 live contract tests、Qwen adapter 及关联 runtime 定向测试。手动 GitHub live workflow 已定义但未在远端运行；其他 executor/pipeline 套件仅注册，未把它们记作本次 live 通过。没有合并或推送。

下一步应先统一默认搜索/记忆 fallback、未决定/暂缓、混合输出约定，再对生产 prompt 做单变量修改与 holdout 验证。本轮没有用降低门槛、删掉原题或改成提示答案的问法使结果变绿。
