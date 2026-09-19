# Connector Foundation Implementation Plan (Plan 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可由伪 provider 驱动的持久来源对象、处理同意和批次更新闭环，保留目录与 IM 行为。

**Architecture:** 在现有 memory worker 的 SQLite 和事务操作内维护 current、激活版本、同意和进度。资源层只负责模型调用与队列，最终 merge 在 worker 内原子校验；host 按批次刷新。此计划不依赖 Composio API，不创建通用插件框架。

**Tech Stack:** Node >=22.13.0、TypeScript、现有 Zod、node:sqlite、node:test。

**Spec:** [已批准设计](../specs/2026-09-19-composio-connectors-design.md)，重点 §4–6、§8、§14。

## Global Constraints

- 仅在 `.worktrees/v0.3.0dev` 工作；保留 `output/` 和其他用户修改；不推送。
- 证据行保持内容寻址；不得增加 current/status/version 字段。来源引用最多 256 字符，证据正文最多 100000 字符。
- 暂停/断开只改变 run epoch；物理删除前先递增 data generation；普通修订不调用 `delete_source`。
- 未取得处理同意不调用 LLM/embedding；旧状态缺少同意记录时不推断已同意。
- `sourceChanged()` 每个已提交批次最多一次失效通知，抽取结束后最多一次就绪通知，不逐对象 flush。
- 不新增依赖、第二个 SQLite 库或锁实现；复用 `acquirePersonalLock`、`schema_migrations`、`personalCommandSchema`。
- 不引入云凭据、Google 算法、macOS bridge、前脑查询工具或组织专属配置。Plan 2 承接这些 provider/桌面集成中的本版范围。
- build 和 test 串行运行，二者都会改变 `runtime/dist`。

## Review Focus

1. 同一 A 再次激活不能被旧 extraction_done 吞掉，亦不能复活已忘记内容（Task 2/4）。
2. 模型请求期间撤销同意、改 scope 或暂停，迟到结果不可写回；混合来源上下文不得夹带未授权正文（Task 3/4）。
3. 重启发生在正文页中间或删除 generation 已 bump 时，进度不可跳过或重复删除新数据（Task 1/5）。
4. 只改已读/标签不应重抽承诺；混合依据失效不能保留包含已失效断言的整段文本（Task 2）。
5. 200 对象、多批并发及通知失败不能造成逐对象 discovery 或丢失最终更新（Task 6）。

## 文件与接口边界

新增 `runtime/src/memory-substrate/source-state.ts`：数据库内来源状态 schema、身份与迁移 DDL；新增 `runtime/src/memory-substrate/source-operations.ts`：事务内连接/页/效力操作。复用 `store.ts` 外层事务；新模块不自行 BEGIN，不新增 worker。`store.ts` 提供既有 append/merge/delete 的内部调用，避免复制脱敏和抑制逻辑。

新增测试 `runtime/test/connector-foundation.test.ts`；资源/宿主/来源适配回归分别加入已有测试。运行指定测试的统一命令：

```bash
npm --prefix runtime run build
node --test runtime/dist/test/connector-foundation.test.js
```

以下类型定义在 `source-state.ts`，均有 strict Zod schema；JSON 采用现有 JsonValue，状态 JSON 上限 64 KiB、单页上限 200 对象/5 MiB，字符串 ID 上限 256，整数均 safe integer 非负。错误使用既有 STORE_INVALID_OPERATION、STORE_IDEMPOTENCY_CONFLICT、STORE_STALE_REVISION；对外不得带正文。

```ts
type Fence = {connection_id:string; generation:number; epoch:number; scope_revision:number}
type ProcessingGrant = {revision:number; scope_revision:number; extraction_provider:string|null; embedding_provider:string|null}
type Activation = {object_key:string; revision:number}
type ExtractionTicket = {evidence_id:string; activation:Activation|null; consent_revision:number; extraction_provider:string; fence:Fence|null}
type SourceChange = {revision:number; phase:'invalidated'|'ready'}
type ObjectChange = {
  object_key:string; source_id:string; semantic_hash:string;
  metadata:Record<string,JsonValue>; evidence:EvidenceRecord[];
  status:'current'|'coverage_removed'|'provider_deleted';
}
type ApplyPage = {fence:Fence; batch_id:string; page_id:string; changes:ObjectChange[];
  pending_ids:string[]; continuation:JsonValue; checkpoint:JsonValue; complete:boolean}
type PageResult = {revision:number; applied:boolean; activations:Activation[]}
```

`object_key` 是服务商账户/对象身份规范序列的 SHA-256；`semantic_hash` 是 provider 规范化语义 JSON 的 SHA-256（不得用将大小写/空白折叠的现有 contentHash 替代）。Plan 1 只验证相同/不同语义摘要的行为；Google 字段归一由 Plan 2 实现。证据 id/hash 继续复用现有实现。

### Task 1: 可迁移的状态与对象身份

**Files:** 新增 source-state.ts、connector-foundation.test.ts；修改 `runtime/src/workspace-graph/store.ts`、`runtime/src/memory-substrate/store.ts`。

**Interfaces:** 导出上述类型与 `connectorSourceId(namespace:string,generation:number,objectKey:string):string`；在现有 `MemoryOperation` 增加 `source_connection`（action 为 create/get/fence/delete_begin/delete_step）、`source_apply_page`、`source_pending`、`source_grant`、`extraction_ticket`、`commit_extraction`、`source_revision`。worker/client 已透传 operation，无新协议通道。

- [ ] 写身份测试并运行，确认新导出不存在而失败：

```ts
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {connectorSourceId} from '../src/memory-substrate/source-state.js'
test('source identities are bounded and generation specific',()=>{
  const a=connectorSourceId('account',0,'x'.repeat(4096))
  assert.ok(a.length<=256)
  assert.equal(a,connectorSourceId('account',0,'x'.repeat(4096)))
  assert.notEqual(a,connectorSourceId('account',1,'x'.repeat(4096)))
  assert.throws(()=>connectorSourceId('account',-1,'x'))
})
```

- [ ] 实现 source ID：`'connector:'+sha256(namespace)+':'+generation+':'+sha256(objectKey)`；资源层 personal prefix 计入 256 总长校验，用户/连接命名空间不得跨用户碰撞。
- [ ] schema 版本由现有 3 升 4，复用迁移事务/表形状验证，旧 1/2 先按原路径到 3；全新库创建既有 v3 表再安装 v4，不提前把版本记为 4。新增表：

```sql
CREATE TABLE source_connections(id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
CREATE TABLE source_objects(connection_id TEXT NOT NULL, generation INTEGER NOT NULL,
 object_key TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(connection_id,generation,object_key)) STRICT;
CREATE TABLE source_pages(connection_id TEXT NOT NULL,batch_id TEXT NOT NULL,page_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(connection_id,batch_id,page_id)) STRICT;
CREATE TABLE source_grants(source_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
CREATE TABLE source_extractions(ticket_key TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
CREATE TABLE source_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
INSERT INTO source_clock VALUES(1,0);
```

连接 payload 保存 Fence、状态、checkpoint、pending IDs、continuation、待删除 generations；对象 payload 保存 current evidence IDs、activation revision、metadata、语义摘要。不得把正文复制进 source_pages receipt；仅保存摘要和 PageResult。证据留在原表。DDL 由 `initializeSourceState(db):void` 导出并复用，生产迁移执行一次；内存测试重复初始化用 IF NOT EXISTS / INSERT OR IGNORE，不能重置 source_clock。

`source_connection` create 输入 `{action:'create',id,namespace}`，返回 `{fence,state:'paused',checkpoint:null}`，起始 generation/epoch/scope_revision 均为 0；同 id/namespace 重放返回原连接，不同 namespace 冲突。get 输入 `{action:'get',id}` 返回完整非密钥连接状态或 null；测试先用 fence action 切到 connected 再 apply。scope 变更输入 `{action:'scope',id,expected_scope_revision,scope:JsonValue}`，同时递增 scope_revision/epoch、撤销旧 grant、清空旧范围分页状态，保留历史证据供 current 效力撤回；不得 bump generation。以上命令留在 worker 内，不新增 renderer 任意内存操作入口。
- [ ] 用现有 WorkspaceGraphStoreClient 测试惯例创建临时磁盘库，验证 v3→v4 重开保留原证据/抑制/向量、升级重复打开幂等、未来版本拒绝、损坏字段拒绝。内存单元测试用 `initializeMemory` 初始化同样 DDL，但不另造迁移注册表。
- [ ] 跑 build 与新测试；通过后只提交本任务文件：`git commit -m "feat(memory): persist connector source state"`。

### Task 2: 原子 current 切换与统一效力

**Files:** 新增 source-operations.ts；修改 store.ts、retrieval.ts；测试 connector-foundation.test.ts、memory-substrate.test.ts。

**Interfaces:** `source_apply_page(ApplyPage):PageResult`，`source_revision({}):number`；`effectiveEvidence(db,id,{now,purpose,provider?})` 返回有效 EvidenceRecord 或 null，purpose 为 local/extraction/embedding。导出共享判定供 store/retrieval 调用，替换重复存在性判断；旧来源无 object 行沿用抑制/保留期检查，不默认失效。数据库内 object 与 source_id 的关联必须可查，不能只凭 evidence 是否在任意 current 集合中判断旧版本。

- [ ] 在 connector-foundation.test.ts 加一个真实 SQLite 场景：create connection → apply A → merge 由 A 支持的承诺 → apply B → apply A。每一步断言 current ID、activation revision、可检索记忆、向量及 history：

```ts
assert.equal(afterB.current_evidence_ids.includes(a.id),false)
assert.equal(afterB.activation_revision,afterA.activation_revision+1)
assert.equal(oldCommitment.op,'tombstone')
assert.equal(afterReturn.current_evidence_ids[0],a.id)
assert.equal(afterReturn.activation_revision,afterB.activation_revision+1)
assert.equal(evidenceRowsWithAId,1)
assert.equal(afterReadFlag.activation_revision,afterReturn.activation_revision)
```

这里 after* 由 `source_connection(get)` 和 `source_pending` 的对象状态投影读取；`source_pending` 返回 `{connection,objects,pages}`，可按 object_key 过滤，默认最多 200 行及继续位置，不允许全库无界返回。a 为既有 EvidenceRecordSchema.parse 的测试记录，时间用测试当前时钟且 retention 在未来。补充只改标签、移出范围再进入、忘记后 A 返回、长 locator、不同 provider 同名联系人、明确用户纠正、混合 A+独立依据的断言。
- [ ] 跑测试确认失败。实现事务算法：先 strict parse/预算及 fence 校验，再按 page receipt 校验 hash；重复同 payload 返回旧结果、不增加 revision；冲突抛 STORE_IDEMPOTENCY_CONFLICT。append 复用既有内部操作，改变 current 后统一撤回派生结果，最后写 page receipt/进度并增加全局 revision。任何失败回滚整页。

```ts
if (!matchesFence(connection,input.fence)) throw Error('STORE_STALE_REVISION')
if (receipt && receipt.payload_hash!==hash) throw Error('STORE_IDEMPOTENCY_CONFLICT')
if (receipt) return {...receipt.result,applied:false}
// 语义摘要与状态均不变时只更新 metadata/观察时间；否则 activation_revision += 1。
```

`matchesFence` 比较全部四项；暂停/断开状态也拒绝同步写入。证据属于同对象 source_id，current 集合非空且全部存在；撤回状态集合必须为空。
- [ ] 对仅依赖失效依据的 inferred 记忆追加 tombstone 并删除向量；混合依据无法证明剩余文本时同样保守 tombstone，排入有效依据重抽取，不能仅删 refs 保留原文本。独立 trusted_user 修订不被覆盖。普通撤回不写 memory_deleted_sources。list/search/readEvidence/evidenceFor、pending vectors/write vectors、merge 和 proposal 引用校验共用效力规则；local 不要求外发许可。
- [ ] 跑指定测试和 memory-substrate.test.js，通过后提交 `feat(memory): derive evidence validity from object activation`。

### Task 3: 持久处理同意与旧调用者适配

**Files:** 修改 resource.ts、`runtime/src/memory/personal-memory.ts`、`runtime/src/memory/entry.ts`、`runtime/src/connectors/feishu/index.ts`、`runtime/src/personal-agent/sources.ts`、`runtime/src/personal-agent/contracts.ts`、`runtime/src/knowledge/service.ts`、production-composition.ts；测试 memory-substrate-resource.test.ts、personal-sources.test.ts、feishu-connector.test.ts。

**Interfaces:** `source_grant({source_id,expected_revision,grant:ProcessingGrant}):ProcessingGrant`；读取 action get，不传 grant。增加 `processingConsent?:ProcessingGrant` 到 recordEvidence/ingestEvidence/MemoryObservation/目录 onObserve 与飞书 ingest；缺省拒绝外发。原 embeddingConsent 不能自动充当抽取许可。

- [ ] 先给资源测试添加未同意、撤销、provider 变化、旧状态重开场景；实际 gateway/embedding 调用计数必须为 0，而 evidence 本地可读取：

```ts
await resource.ingestEvidence({sourceId:'old-im',locator:'m1',text:'周五交报告',
 observedAt:new Date().toISOString(),kind:'im'})
await resource.flush()
assert.equal(modelCalls,0)
assert.equal(embeddingCalls,0)
```

复用现有测试的临时目录/ModelGateway 假对象；已有预期抽取成功的 fixture 显式传 grant，保留一个缺省 fixture 防止迁移时误授予许可。
- [ ] 持久 grant 绑定 scope_revision 和真实配置得到的模型/embedding fingerprint（provider endpoint/model/config identity 的稳定摘要，不含密钥）；不接受 renderer 提供的 fingerprint。scope 改变使旧 grant 无效；revision CAS 防止旧回调覆盖撤销。本地会话的 inputConsent 只作用于该会话来源，不能越权覆盖外部来源。
- [ ] 飞书 configure 保存现有 checkbox 的明确值与 scope revision；目录 add 保存同意记录；缺失记录用 null，保留本地数据，在状态投影加入 `processing_consent_required`。增加 `sources.consent` 和 `feishu.consent` 到 personalCommandSchema，参数 `{id?,consent:boolean}`，按各自稳定来源标识处理；撤销不要求重新新增目录或重做 OAuth。Task 3 不新做 UI，状态与命令供 Plan 2 接线。
- [ ] 删除 composition 两个硬编码 true。KnowledgeService.syncFile 增加显式处理许可参数并向 recordEvidence/embedding 传递；扫描读取许可与外发许可分开。找到所有 syncFile、recordEvidence、observeSource 调用者逐个更新，不能在默认参数中回填 true。

```ts
await memory.observeSource({...observation,processing_consent:observation.processing_consent})
// ingest 调用逐字段透传已持久 grant；绝不由“已连通”合成 grant。
```

MemoryObservation 的公共字段用 `processing_consent`，TS ingest/recordEvidence 参数用 `processingConsent`，适配边界只转换一次。
- [ ] 测试旧飞书/目录 JSON 没 grant 不外发、重新确认后只处理有效证据、重启保留许可、暂停/断开不删除、knowledge 路径没有绕过门控。跑上述三组测试和 typecheck，通过后提交 `fix(memory): enforce explicit processing consent across sources`。

### Task 4: 模型返回的事务校验与激活版本去重

**Files:** 修改 resource.ts、source-operations.ts、store.ts、retrieval.ts；测试 memory-substrate-resource.test.ts、connector-foundation.test.ts。

**Interfaces:** `extraction_ticket({evidence_id,provider,force?:boolean}):ExtractionTicket|null`；`commit_extraction({ticket,candidates:Candidate[],extracted:Record<string,JsonValue>}):{applied:boolean}`。候选、联系人实体和完成标记一次提交，不能逐个 merge 后再写 done。force 只绕过去重，不绕过效力/同意。

- [ ] 用已有 deferred gateway 测试风格阻塞模型响应；分别切换 A→B→A、撤销 grant、改变 scope、暂停、forget，再释放旧响应。断言没有旧候选、联系人或 extraction 完成标记：

```ts
const ticket=await client.memory('extraction_ticket',{evidence_id:a.id,provider:'fixture'})
await client.memory('source_grant',revokeRequest)
assert.deepEqual(await client.memory('commit_extraction',{ticket,candidates:[],extracted:{entries:[]}}),{applied:false})
```

revokeRequest 使用 Task 3 返回的 grant revision + 1 且两 provider 均 null；不要用任意随机 revision。
- [ ] 实现 ticket_key = hash(evidence_id, activation revision, consent revision, extraction provider)。旧无对象证据 activation=null 仍检查 grant；新对象不受老 memory_extractions 完成标记阻塞。队列/在途去重也使用 ticket_key，不能仍按 evidence.id 独占而丢失新激活唤醒。
- [ ] 队列出队先取得 ticket；组装 prompt 之后、调用 gateway.complete 之前再取票验证；existing 上下文只含全部依据对该 extraction provider 获同意且有效的条目。Embedding 在调用前重查整批票据，返回后 write_vectors 再校验；避免只在返回后拒绝却已经外发未授权正文。已经发送的请求尽力 Abort，不能声称可收回。
- [ ] commit_extraction 在事务中再次比较 activation/fence/grant/retention/suppression，然后调用原 merge 内部操作并写 source_extractions。过期票据返回 applied:false，不写任何候选。任务完成后重新扫描持久 pending，A 再激活必可重抽；source_metadata 加可选 provider，旧缺省 im 显示飞书，mail/calendar 不显示“飞书联系人”。
- [ ] 正向断言 B 的承诺生效、A 返回可重建且已忘记内容不复活；并行来源未授权 existing 不进入 prompt；同意撤销期间 embedding 不落库。跑上述测试，通过后提交 `fix(memory): fence extraction commits by activation and consent`。

### Task 5: 页恢复、删除恢复与有限工作量

**Files:** 修改 source-operations.ts、source-state.ts；测试 connector-foundation.test.ts（用磁盘 SQLite 和真实 worker）；不新增调度框架。

**Interfaces:** `source_connection({action:'fence',id,state:'paused'|'connected'|'disconnected',expected_epoch}):Fence`；`delete_begin` 原子 bump generation+epoch 并记旧 generation；`delete_step({id,limit:200}):{remaining:boolean}`。`source_pending` 提供待处理 ID/continuation 与未抽取 activation 的有界读取。所有操作检查连接归属。

- [ ] 构造 200 ID 的伪 provider 列表，先保存 pending，再 apply 其中 20 个正文并关闭 worker；重开断言其余 180 个仍 pending，checkpoint 未推进，重放已应用页无副作用。`complete:true` 且 pending 非空必须失败：

```ts
await assert.rejects(client.memory('source_apply_page',{
 ...page,complete:true,pending_ids:['still-unread']
}),/INVALID_OPERATION/)
```

- [ ] 实现页提交只更新当前 continuation/pending，完成整个 provider 批次且 pending 为空才安装 checkpoint。页输入同时超过 200 对象、5 MiB 或 JSON 限制即拒绝。正文获取失败必须留 pending/error，不伪装为删除。receipt 按连接批次保存，完成批次仅保留当前和上一完成批次；旧 batch 必须由单调 batch 序号 fence 拒绝，不能因 receipt 清理而接受旧重放。把 batch 序号放入连接 payload，batch_id 格式为该序号字符串，strict 校验。
- [ ] delete_begin 先提交新 generation 和待删列表；delete_step 每次最多 200 旧 source_id，复用 delete_source 并同事务推进清理位置。断电后从列表继续，永不扫描新 generation；清理结束删除旧 object/page 状态，保留永久删除记录。暂停/断开只 fence，测试 memory_deleted_sources 无新增。
- [ ] 测试 delete_begin 后崩溃、清理中崩溃、新 generation 同原 ID 重采、旧 epoch/旧 scope 页迟到被拒、非重叠两个 worker 打开同一 personal 状态被既有锁拒绝。模型未启动时允许状态配置，账本不可用则明确失败而不保存“已同步”。
- [ ] 跑 build、新测试与 personal-agent.test.js；通过后提交 `feat(memory): recover connector batches and deletion generations`。

### Task 6: 合并宿主通知与跨层回归

**Files:** 修改 resource.ts、`runtime/src/personal-agent/host.ts`、production-composition.ts；测试 personal-agent.test.ts、memory-substrate-resource.test.ts。

**Interfaces:** 扩展 `sourceChanged(change?:SourceChange):Promise<void>`，无参数保持目录兼容。资源层暴露 `setOnSourceChange(listener:(change:SourceChange)=>Promise<void>):void`；source_apply_page 提交后发 invalidated，该批 activation 全部处理完或已终止后发 ready。无 processing grant 的批次只失效，不等待一个不会发生的抽取。

- [ ] 构造一页 200 对象，deferred gateway 阻塞抽取；计数 refreshMemory/revalidate/discover。提交后立即验证旧 proposal 的 canDeliver=false；释放批抽取后计数：

```ts
assert.equal(invalidatedNotifications,1)
assert.equal(readyNotifications,1)
assert.ok(discoverCalls<=1)
assert.equal(await host.canDeliver(oldProposalId),false)
```

- [ ] 实现 host 合并最新 revision 与两个 phase 的独立进度；相同 revision 的 ready 不得被已收到 invalidated 吞掉。invalidated 先 refresh/revalidate，禁止直接发现未处理内容；ready 依据 source_clock + 目录 refs 签名 discover。通知期间有更高 revision 进来则再 drain 一轮，不丢尾部更新。
- [ ] 持久 source revision 作为恢复依据：listener 失败保留待发 revision，maintenance 重试；host 启动读取当前 revision 并重验，不依赖曾成功调用回调。资源 #refresh 的逐对象 onChange 不再触发全局 discovery；保留非 connector 记忆刷新用途。无需持久通用消息总线。
- [ ] 测试交错两批、同 revision 两阶段、listener 抛错后重试、重启补验、旧目录 sourcesChanged()、飞书 bot 不因 connector ingest 改动而获得额外写权限。
- [ ] 顺序执行最终检查：

```bash
npm --prefix runtime run typecheck
npm --prefix runtime run lint
npm --prefix runtime test
git diff --check
```

既有失败记录基线与本次关联，不能删断言让测试过。完整通过后更新 STATUS 的 Plan 1 本地回归证据；不得标记 M8-Mail 账号/安装版通过。提交 `feat(personal): coalesce source batch invalidation and discovery`。

## 自审与交接

覆盖：§4 批通知→Task 6；§5 同意→Task 3/4；§6 身份/效力/迁移→Task 1/2/4；§8 删除恢复→Task 5。网络预算、Google 语义、scope OAuth、密钥、HTML 清理和桌面 UI 属于 Phase 0 / Plan 2；本计划不声称完成这些部分。Review Focus 五项均分配到实际任务。

执行顺序 1→2→3→4→5→6；Phase 0 可独立进行。每次提交前确认 git diff 仅含负责文件，不包含 output/ 或 runtime/dist 生成物。计划待用户审阅后实施。
