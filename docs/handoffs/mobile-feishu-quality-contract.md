# 移动端飞书质量迁移：实现契约（2026-10-30）

本文件是 T1–T4 的共享契约，由主控维护。背景、验收场景与约束见 [mobile-feishu-quality-next.md](mobile-feishu-quality-next.md)，PC 对照见 [../reviews/mobile-pc-feishu-parity-2026-10-30.md](../reviews/mobile-pc-feishu-parity-2026-10-30.md)。手机路径以 `clients/flutter/lib/` 为根，PC 以 `runtime/src/` 为根。

## 通用约束

- 只用公开/合成测试数据；不引入 internal/pilot 代码、租户数据、真实聊天、姓名或账号标识。
- 不扩大飞书权限：不调用通讯录，不为补元数据额外请求单条消息详情，不从正文猜姓名。缺字段保持 unknown。
- 不放宽现有校验：逐字 quote、单主题引用、逐卡复验、批次隔离、partial/pending、授权/过期/预算中止全部保留。不靠更多重试、删除代号或替换引用制造正确结果。
- 测试断言宿主行为与模型输入结构；只断言提示词包含某句话不算内容验收。
- 每个 worker 只在自己的 worktree 修改，按任务说明的 TMPDIR/输出目录运行 Flutter；不清共享目录。完成前在自己 worktree 跑 `flutter analyze --no-pub` 与相关定向测试，并报告命令与结果。

## 证据记录契约（T1 产出，T2/T3 消费）

`SourceStore` 消息新增字段（只取飞书响应原有内容，旧记录缺省即 unknown/缺失）：

| 字段 | 取值 | 来源 |
| --- | --- | --- |
| `sender_type` | `user` / `app` / `unknown` | `sender.sender_type` |
| `mention` | `direct` / `all` / `none` / `unknown` | 顶层 `mentions[]`：`id`（id_type 缺省或 open_id）等于本人 open_id → direct；`id=="all"` → all；有数组无匹配 → none；无数组 → unknown；本人发送 → none。对应 PC `connectors/feishu/index.ts` structuredMention |
| `mention_ids` | `ou_` 开头 id，≤50 | `mentions[].id` |
| `parent_id` `root_id` `thread_id` `upper_message_id` | 1–256 字符字符串 | 同名字段 |

`ProfileEvidence.records` 每条交给模型的形状（JSON 对象，键固定）：

```json
{
  "evidence_id": "e3",
  "chat": "c1",
  "author": {"key": "self|p1|unknown", "kind": "person|app|unknown", "is_user": true},
  "relation": "self|addressed|participant|app|unknown",
  "links": {"parent": "e2|outside_window", "root": "e1|outside_window", "forwarded_in": "e5|outside_window"},
  "mentions_user": true,
  "created_at": "2026-10-29T08:00:00.000Z",
  "local_date": "2026-10-29",
  "text": "..."
}
```

- `author.key`：本人 `self`，其他发送者按出现顺序 `pN`，无 sender_id `unknown`。
- `author.kind`：`sender_type=user` → person，`app` → app，其余 unknown（旧记录但 sender_id 为 open_id 时也是 unknown，不推断）。
- `author.is_user` = `kind=="person" && relation=="self"`；旧记录 kind=unknown 时为 `relation=="self"`（保持旧语义：只证明本人发送）。
- `relation`：sender_type=app → `app`；本人 → `self`；非本人且 mention=direct → `addressed`；有 sender_id → `participant`；否则 `unknown`。
- `links` 仅在原消息有对应字段时出现；目标在本次 records 内映射为其 eN，否则 `outside_window`。`upper_message_id` 映射为 `forwarded_in`。
- `mentions_user` 仅在 mention 为 direct 时出现（值 true）。
- `local_date`：按设备当前时区把 created_at 换成 `YYYY-MM-DD`；`ProfileEvidence` 接受可注入的时区偏移以便测试。
- 移除 `speaker` 与 `body_authorship`。

## 版本常量

| 常量 | 旧值 | 新值 | 作用 |
| --- | --- | --- | --- |
| `ProfileObservationCheckpoint.algorithm` | `profile-observations-v2-refs24` | `profile-observations-v3-author`（T1）→ `profile-observations-v4-relevance`（T3） | 旧观察不复用 |
| `TimelinePipeline.recipe` | `timeline-pipeline-v1` | `timeline-pipeline-v2`（T2）→ `timeline-pipeline-v3`（下一步上限 1） | 旧阶段 checkpoint 不复用 |
| `profile_agent.dart` 结果 recipe | `timeline-batched-v6` | `timeline-batched-v7`（T2） | 触发重新整理 |
| Timeline 卡 `policy_revision` | 无 | `2`（T2） | 缺失或 <2 的旧卡不作为可信内容展示或保留 |

## T1 采集与证据元数据（worker-1）

1. Feishu 消息规范化写入上表字段。
2. 采集元数据修订：已有聊天在下次同步时对近 14 天窗口做一次元数据补读，同 id 记录原地补字段（正文、状态按常规规则更新），完成后记修订号，不重复补读；只花网络读取，不触发额外模型调用。窗口外旧记录保持 unknown。原始消息、人工纠正、其他 Space 数据不删除。
3. `ProfileEvidence` 按记录契约渲染；`checkpointRecords` 带上新字段，使旧观察批次失效。
4. 来源界面（`ui/local_profile_results.dart` 来源行）区分“我 / 直接@你 / 其他参与者 / 应用或机器人 / 未知”，中英文都要。
5. 测试：bot 回报、@本人、@all、回复链（窗口内/外父消息）、转发容器、缺字段旧缓存、补读后元数据出现且不重复补读、补读不调用模型。

## T2 Timeline 规则分离与独立近期原文（worker-2）

1. `timeline_brief.dart` 的 `timelinePerspectiveRules` 以 PC `model/timeline-perspective.ts` 的 TIMELINE_PERSPECTIVE_RULES 为蓝本改写，字段名换成本契约（author.is_user / relation addressed|app / links / context.viewer_names / local_date）；并入 PC `#composeTimelineBatch` 关于 self 仅指发送者、被@不代表承诺、消息时间不等于发生时间、优先 recent_since 之后的规则。
2. Timeline 的 compose / review / select / reconcile 指令都不含 `profileGrounding`；加契约测试。
3. Timeline 输入独立于 Profile 观察：`TimelinePipeline` 直接消费 `records`；只取 `local_date >= recent_since`（local_date − 14 天）的原文，另加已发布可信卡仍引用的原文并标 `history_only:true`。输入附 `context:{local_date, timezone, recent_since, viewer_names:[]}`（手机无可信本人姓名元数据，保持空数组）。
   - 输入 ≤120 条且 JSON ≤48000 字符：直接 compose（单主题，所有记录），跳过 select/reconcile。
   - 超出：原文分批筛选 `{key, group, at, relation, author, text}` → 现有 reconcile → `timelineWritingPlan`；原文不截断，超容量主题照旧 deferred 并计 pending。
   - Profile 失败不阻塞 Timeline，Timeline 失败不阻塞 Profile；各自的诊断码保持。
4. 时间：brief 增加 `temporal:{kind, dates:[{role, date, ref, quote}]}`，规则与校验移植 PC `personal-agent/timeline-time.ts` 到新文件 `context/timeline_time.dart`（kind: event/ongoing/deadline/scheduled/synthesis/background/unknown；role: occurred/started/deadline/scheduled；日期必须出现在 ref 原文 quote 中，相对日期按该消息 local_date 换算；消息自身日期不当 occurred；deadline/scheduled 缺对应日期无效；background 丢弃；锚点早于 recent_since 且无后续期限的卡按 outside_window 丢弃）。解析结果存为卡片 `time`，界面日期改用 `time.anchor_date`（无则保持来源时间）。
5. 版本：见版本常量表。`profile_repository` 发布与读取时，缺 `policy_revision` 或 <2 的 timeline 卡（含 preserved history）不再展示或保留为可信内容；原始消息与人工纠正保留。
6. 测试（合成数据、fake `complete(stage, instructions, input)`）：协作者“我验证完成”的 author.is_user=false 并且模型写成本人完成时被审查删除的流程；只有他人事务 → 0 卡且非失败；bot 回报；日期角色拒绝；好坏卡混合；旧 revision 卡升级后消失；小输入跳过 select；大输入走分批。

## T3 画像选材（worker-1，T1 与 T2 合并后）

1. 观察 `{text, refs, relevance}`，relevance 取 PC observeProfile 枚举；checkpoint 校验允许该键。
2. 宿主排除 one_off_task / reference_material / uncertain；repeated_pattern 的 refs 需对应 ≥2 条不同原文。
3. 移植 PC observeProfile 分类提示与 PROFILE_GROUNDING 中 addressed / app / links 规则到 `profileGrounding`。
4. 测试：一次性验收不进画像；repeated_pattern 单来源被拒；旧观察（无 relevance）不复用。

## T4 Timeline 增量身份（worker-2，T2 合并后）

1. 卡 id：模型给出且属于当前 scope 已有卡的 `prior_id` → 沿用；否则 `timeline_` + hash([title, sorted refs])。
2. 输入 context 增加 `prior_cards`（≤32：id, title, why_now≤120, anchor_date）与 `new_input_ids`；移植 PC `TIMELINE_DELTA_RULES`（`model/personal-writer.ts`）；旧卡摘要不是事实证据。
3. 省略不等于删除：未被修订的可信旧卡保留。
4. 测试：修订旧卡 id 稳定；未知 prior_id 回落；无变化不调用模型。
