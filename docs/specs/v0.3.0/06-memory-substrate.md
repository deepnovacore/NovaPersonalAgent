# 06 · 记忆底座方向

状态：设计方向，尚未实现。2026-09-13 图谱退役后新增本说明；不代表已有迁移或新存储。

底座从 `evidence_record` / `entry_revision` 直接起步，实体与关联按记忆场景定义。
VoiceMem 可作为后续写入方；不复用已退役的图谱 schema 或 projector。
敏感内容与路径策略已迁至 `runtime/src/memory/sensitivity.ts`，现用知识库与桌面策略继续复用，行为不变。
图谱 store 的 SQLite、迁移与 revision 工具没有保留模块的实际消费者，因此不新增闲置存储工具。
既有图谱 SQLite 用户数据不自动删除；新底座的数据迁移需另行定义与验证。
