# 记忆后端独立验收

**2026-11-03 结论：MEM0、VoiceMem 各自在下述有限 synthetic 矩阵内 PASS。** 两位实际执行者均不是实现作者，各自完成隔离构建与一次真实模型验收；未发现各自矩阵内的阻断缺陷。此前只读报告的 NOT_RUN 不计作实测。

代码绑定提交：`d3dc9b761c8525bea2813cb6338cc685327553e4`，分支 `integrate/memory-backends-20261103`。两组执行前后 HEAD 一致，仓库改动及暂存均为 0；后续仅文档提交不改变本次受验代码。配置、使用和回退见[交付指南](memory-backends-delivery.md)。

## 测试对象与真实边界

| 对象 | MEM0 独立验收 | VoiceMem 独立验收 |
| --- | --- | --- |
| 事实组合 | `MEMORY_RECALL_ENGINE=mem0`，`MEMORY_EXTRACTORS=ledger`；仅一个 active mem0，styles off | `MEMORY_RECALL_ENGINE=voicemem`；先全新事实库、`MEMORY_EXTRACTORS=ledger`，再不同全新风格库、`ledger,voicemem`；各仅一个 active VoiceMem |
| SDK | `mem0ai/oss` 3.2.0，SDK 自有持久 vector store；对账本事实以 `infer:false` 索引，不重复调用 mem0 LLM 提取 | `voicemem` 0.0.1，自有隔离补丁副本；协议 `voicemem-0.0.1/grounded-reply-preferences-v1` |
| 实际来源 | 1 次 remember、2 次独立显式写入，另有版本纠正 | 8 次 remember：事实 1、风格 7（一次性要求 3、情绪 1、长期偏好 3）；另有 2 次显式写入 |
| 真实模型与路径 | 两组均使用真实 `qwen-plus` / `text-embedding-v4`，运行实际配置、组合、账本、SDK 入库/搜索、授权及持久清理路径；不是 fake engine | 同左；风格抽取也调用真实模型 |
| 阶段及 fixture | 13 个 live 阶段 PASS；独立配置/组合 fixture 10/10 | 19 个 live 阶段 PASS；独立 SDK/升级/缓存 fixture 4/4 |
| 单次总耗时 | 17.894 秒 | 90.877 秒 |

**两模式使用不同语料、步骤和设置，17.9/90.9 秒不能用于比较后端速度，也不是 p50/p95。** fixture 与 live 是不同证据，不把表内拆开的复合断言相加为更多试验。

真实范围包括记忆抽取及所需 resolution、embedding、SDK indexing/search。实时音频 transport 为 stub；实际 ASR、回答 LLM、TTS、听感、GUI/App 和真机均未验收，不能称为语音端到端通过。

## 逐项结果

| 检查项 | MEM0 | VoiceMem | 范围与观察 |
| --- | --- | --- | --- |
| 配置、资源与工具能力 | PASS | PASS | 实际资源/引擎与配置一致；账本 remember/lookup 等能力保留。 |
| 真实抽取、SDK 持久索引、canonical 水合 | PASS | PASS | 搜索结果与账本 id、text、revision、证据一致；有真实 SDK 持久存储佐证。 |
| 接收模型允许 / 陌生接收者拒绝 | PASS | PASS | 实际 UnifiedRetrieval 对已授权接收者返回事实，对陌生接收者返回空。 |
| general 显式查询与 userOnly 隔离 | PASS | PASS | general 可显式召回并标 scope，userOnly 不混入；MEM0 还检查实际 prerecall 不带 general。general 未被冒称进入 SDK user 索引。 |
| 新 revision 纠正、全新 client 重启 | PASS | PASS | 相同 canonical id 返回新版本/文本，旧文本不复活；重新构造 composition/client，不 reopen 已关闭 client。 |
| 事实 forget、重启不复活 | PASS | PASS | 遗忘后及全新 client 重启后均无该事实。 |
| 整个引擎目录物理 purge | PASS | PASS | 清理前确认 synthetic sentinel 存在；扫描 SDK、manifest 及现存 WAL/journal 等文件，确认字节消失后才确认 complete。不是只检查逻辑隐藏。 |
| 默认 styles off | PASS | PASS | 默认事实场景不返回 contextHits；未改默认开关。 |
| 事实处理授权撤回/恢复 | PASS | NOT RUN（本项） | MEM0 revision 2 撤回后不可处理/读取，revision 3 恢复后原 canonical 事实可召回；VoiceMem 本次授权生命周期针对下列风格来源。 |
| 同一数据库跨用户隔离 | PASS | NOT RUN | MEM0 用公开 `MEMORY_USER_ID`、相同数据库和引擎根目录另建组合，另一用户 list/recall 无原用户事实。 |
| 三次一次性要求不成特质/账本事实 | NOT RUN | PASS | VoiceMem 不增加第四个来源来修补结果。 |
| 临时情绪是 experience 而非 trait | NOT RUN | PASS | 未形成账本事实/偏好；随后遗忘该情绪，避免残留 experience 掩盖“无 hint”检查。 |
| 长期偏好 1/2 次无 trait，第 3 次两维 EXACT3 | NOT RUN | PASS | length/directness 各精确对应三个独立来源，无额外 ordering；实际 projection/prerecall 可消费 hint。 |
| 风格撤回实际生效 | NOT RUN | PASS | 正确 await void API。source 1 revision 2 持久化，三类授权读均拒绝，source 2/3 仍允许；SDK manifest 移除被撤回来源，fresh 无 trait/hint。 |
| 风格恢复不增加来源、不续期 | NOT RUN | PASS | revision 3 恢复，不再 remember；两维仍 EXACT3，recordedAt/expiresAt 与撤回前逐项完全相同。 |
| 风格 forget 后全新 client 重启 | NOT RUN | PASS | 遗忘 source 2 后低于门槛，重启仍无 trait/hint。 |
| TTL 最早证据锚定 | NOT RUN | PASS | recordedAt 为最早 observed_at，expiresAt 精确加 600000ms；查询/恢复均未改写。不是自然等待十分钟的实测。 |

## 本轮未运行的内容

| 范围 | 状态与边界 |
| --- | --- |
| mem0 + VoiceMem 混合 styles smoke | MEM0 本轮 NOT RUN；不能拿本轮默认 styles off 的事实矩阵代替。此前 v2 的混合风格证据另行保留。 |
| 旧 standalone mem0 真实 provider | NOT RUN；本次 mem0 是 ledger 权威组合，不是旧 `MEMORY_PROVIDER` 模式。 |
| VoiceMem 更多改写/opposite live | 本轮 NOT RUN；已有此前 v2 观察及本次 deterministic fixture，不冒充此次 live 追加样本。 |
| 自然等待十分钟过期 | NOT RUN；本次真实 TTL 锚点/不续期与 fixture 过期检查不能替代自然等待。 |
| 全套、更多语料/语言、规模与统计性能 | NOT RUN；不能外推有限 PASS。 |
| 音频、GUI、设备、手机/远端/备份 | NOT RUN；仍按[交付指南的未验收项](memory-backends-delivery.md#尚未验收)保留。 |

## 次数纪律与证据索引

MEM0 的 11 次显式 flush 均首次成功。VoiceMem 共 24 次显式 flush，其中 2 次仅对已知 pending 类问题作受限重试；未重试查询或质量失败。每来源只 remember 一次，恢复授权不增加 admission。既有 durable timer 可处理同一来源，**这些次数不是 HTTP 请求总数**。

两组均使用预声明案例、独占隔离构建与保留的私有 synthetic 状态；操作限额为每步 90 秒、整轮 300 秒、清理 30 秒。它们是用户新要求的两后端分别验收，不是恢复旧数据库或反复变更输入追求旧报告变绿。

本机私有证据以两份 **execute-v1** 实际 `acceptance-report.md`、各自计划/脚本、隔离构建日志及机器结果为准。公开文档只记录以下结果文件哈希作为索引，不附私有目录或原始语料：

- MEM0 `live-result.json`（`PASS`，13 阶段）：`15ce829920b33851cfd1c9e391b4d8b6c28217d29be715206ff1dc1b3c85b485`。
- VoiceMem `result.json`（`passed`，19 阶段，8 admissions）：`fd04cedad2614e37ec7e7eea196e19d5f0692cfed4a4e2fc9c05a298d71050ab`。

历史 v1 中断及 v2 的 `quality_failed` 均未改写。v2 当时因 void 返回值误断言而缺少的撤回、恢复、遗忘和重启观察，**已由本次独立 VoiceMem 实际验收补上**；这不把旧 v2 改成 PASS。历史细节见[技术说明](../design-notes/2026-11-03-memory-backend-composition.md)。三来源规则仅约束派生风格提示，不限制用户一次明确保存 ledger 偏好；默认 styles/prerecall 仍关闭。
