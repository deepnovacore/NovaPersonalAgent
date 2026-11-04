# 记忆后端交付与使用

集成目标分支：`integrate/memory-backends-20261103`。本文说明本次交付范围，不表示已发布客户端或真机验收全部完成。

## 交付了什么

- **Nova ledger 始终权威**：事实、版本、原话证据、授权、纠正和遗忘由账本管理。mem0 / VoiceMem 是可选的召回与派生索引，不是另一份可自行改写的用户事实。
- 使用 `MEMORY_RECALL_ENGINE` 选择候选召回引擎后，仍保留账本产品能力和按实际能力开放的 `memory__recall`、`memory__evidence`、`memory__lookup`、`memory__remember`；返回结果会重新核验账本版本与来源授权。索引失败会报告降级，不会偷偷换成另一个引擎。
- **Plan / Build 文字写入仍须明确请求**，逐字引用当前用户文字回合的 `quote`，只有 committed 回执才算保存。项目、代码、仓库约束用 `scope=general`，用户本人稳定信息用 `scope=user`。文件、工具结果和语音转写不能替代该文字回合的保存授权；Plan / Build 语音没有记忆写入工具，也不自动学习。
- `general` 内容可显式授权查询，但不进入自动用户事实/回复风格背景。记忆不是执行任务的授权；旧缓存也必须重新核验。

这里的“mem0 召回引擎”不同于旧 `MEMORY_PROVIDER=mem0` 的独立模式。手机 Flutter **standalone Space** 的本地记忆也与此分离：它使用本机显式保存机制，不是桌面 SDK 向量索引；Client 使用 Host 记忆，不合并或同步 standalone 记忆。详见[个人记忆](personal-memory.md)、[手机独立模式](iphone.md#flutter-独立模式的本地记忆)和[Space / Host / Client](space-host-client.md)。

## 最小配置

先保证本机已有可用的 embedding 与 fast/抽取模型配置。本次仅切换记忆组合，**不用新增记忆专属密钥或 Mem0 云密钥**：沿用现有 embedding 配置、`FAST_MODEL` / 模型路由及其凭据。模型服务仍可能接收获授权文本；本地存储不等于离线处理。

以下配置分别使用，不要叠加互相冲突的旧变量。

### 默认账本

```dotenv
MEMORY_CONNECTION=local
MEMORY_PRERECALL_ENABLED=false
# 不设置 MEMORY_PROVIDER、MEMORY_RECALL_ENGINE、MEMORY_EXTRACTORS
```

这是默认 ledger，并保留旧记录的只读迁入路径。若要显式选择、且不走该旧迁入路径，设置 `MEMORY_RECALL_ENGINE=ledger` 和 `MEMORY_EXTRACTORS=ledger`。

### mem0 召回，账本提取

```dotenv
MEMORY_CONNECTION=local
MEMORY_RECALL_ENGINE=mem0
MEMORY_EXTRACTORS=ledger
MEMORY_PRERECALL_ENABLED=false
```

### VoiceMem 召回，账本提取

```dotenv
MEMORY_CONNECTION=local
MEMORY_RECALL_ENGINE=voicemem
MEMORY_EXTRACTORS=ledger
MEMORY_PRERECALL_ENABLED=false
```

两种 SDK 召回均不自动开启风格抽取。如明确需要试用短期风格背景，将对应示例中的提取器一行**替换**为：

```dotenv
MEMORY_EXTRACTORS=ledger,voicemem
```

`ledger` 不能省略，不能重复列出提取器。风格抽取与语音 prerecall 是不同开关；本交付不默认开启二者，也不启用新的默认优化。Workbench 既有文字检索不由 `MEMORY_PRERECALL_ENABLED` 控制。

**兼容限制：**没有 `MEMORY_BACKEND` 别名；`MEMORY_PROVIDER` 已弃用，不能与两个新组合变量共用。旧 `voicemem` 保留账本迁入，旧 `mem0` 保留独立模式，并不等于上述新组合。远程连接的引擎由服务端选择，不接受这两个本地覆盖变量。更多路由说明见[配置指南](configuration.md)。

## 风格背景的边界

VoiceMem 固定版本补丁在 SDK 内、嵌入和证据合并之前校验整句来源，只支持闭合的中英文第一人称长期回复偏好语法：**长度 `length`（简短/详细）和直接程度 `directness`（直接/委婉）**。这不是自由人格推断；未知措辞可能直接不采纳，不推断回答顺序、身份或事实偏好。例如“我一直偏好简短的回复。”符合这一整句模式（仅为语法示例，不是实测原始语料）；长段叙述、夹杂说明或请求前缀可能保守地不命中。

**三来源/十分钟规则约束的是 VoiceMem 派生 trait 提示，不是显式账本偏好的保存条件。** 用户一次明确要求、引用当前原话并收到 committed 回执，就可以保存账本偏好；无需重复三次，也不会因此强制十分钟后删除。

- 特质至少需要 **3 个不同、仍获授权的用户对话来源**。同一来源重试、撤回后重新处理，都不会变成新的独立支持。
- 背景从**最早证据起最多 10 分钟**，不会因查询、重试或缓存消费续期。临时情绪可作为短期体验，不因此成为长期偏好。
- 一次性要求、第三方陈述、引语和不支持的否定表达不构成长效风格；可识别的显式否定只用于保守抑制，不作为偏好提示。
- 相反取值会抑制该维度，即使相反来源不足 3 个；不冲突的维度可以保留。权威来源清单改变后，旧风格缓存失效，不能绕过新矛盾；无关事实仍独立验证。
- 这些数据只走有界 `contextHits` 风格通道，不写成账本事实，也不提供动作权限；当前请求优先。

## 启动、构建与升级

源码部署沿用已有桌面入口 `npm run start:client`；它会先构建再启动，不提供热重载。修改实际使用的配置后，退出并重启对应桌面/Host 后台。源码启动的项目 `.env` 会覆盖同名 shell 变量。发布版与 Host 的入口继续按[上手指南](getting-started.md)及[Space 部署说明](space-host-client.md)操作；本次没有新增 GUI 引擎选择器，也未做新一轮 GUI/真机构建验收。

并行开发不要清理共享构建目录。Space 的已支持隔离编译路径为：先准备内置存储上的已有独占目录，再替换下列占位符：

```sh
node scripts/build-space-stack.mjs \
  --output-root "<internal-build-root>" \
  --run-id "<unique-run-id>"
```

输出按规范 worktree 路径及 run-id 隔离。它只构建隔离的 Space 栈，不会启动 GUI，也不会自动替换已运行桌面的代码。不要使用外置盘或共享其它任务的输出目录。

补丁位于仓库的 [`runtime/sdk-patches/voicemem-0.0.1`](../../runtime/sdk-patches/voicemem-0.0.1/PATCH-NOTICE.md)。构建会校验准确的版本和完整原始文件哈希，再制作自有 SDK 副本；不会修改共享 `node_modules`。校验失败应停止构建，不应绕过。协议变化会触发旧派生索引退役、清理与获授权来源回填，**不重写 ledger 事实**；这不是上游已发布的新版本。

## 已验证到哪一步

最新独立验收见[两后端逐项 PASS / NOT RUN](memory-backends-acceptance.md)：2026-11-03，两位非实现作者分别在提交 `d3dc9b761c8525bea2813cb6338cc685327553e4` 上完成实际执行，MEM0 与 VoiceMem 各自在有限矩阵内 PASS。

各组范围和代码时点不同，存在重叠，**不能机械相加成“最新全套通过”**。

| 证据 | 结论与边界 |
| --- | --- |
| 最新 MEM0 独立实际验收 | 默认 ledger 提取、styles off；13 个 live 阶段及 10/10 配置/组合 fixture 通过。真实事实入库/搜索、授权撤回恢复、scope、纠正、跨用户、新 client 重启、forget 和物理 purge 均通过；本轮未跑混合 styles 或旧独立 mem0 live。 |
| 最新 VoiceMem 独立实际验收 | 默认事实库及另一全新风格库；19 个 live 阶段及 4/4 fixture 通过。8 次唯一 remember + 2 次显式写入；补齐风格撤回、无新 admission 的恢复、EXACT3/原 TTL 不变、forget 后新 client 重启等真实观察。未跑自然十分钟等待、可选跨用户、更多改写/opposite live 或音频/设备。 |
| 297 项集成组 | SDK 定向补丁前的集成基线通过，不是新 SDK 的全量复测。 |
| SDK、生命周期、打包及缓存定向检查 | 真实 SDK + HTTP fixtures 覆盖结构化支持、冲突、撤回/遗忘/到期/重启、完整性打包、Space 输出和缓存矛盾；针对性检查通过，不等于真机或所有客户端全套验收。 |
| 两种事实引擎各 11 项真实功能检查 | SDK 定向补丁前，两组功能通过；当时报告仍为 partial，旧特质质量失败另行保留。三次召回样本不是延迟百分位。 |
| 此前新 SDK 的一次真实 v2 试验 | 8/8 次尝试均获入库确认，约 88.8 秒、10 次显式 flush。三次重复一次性要求未成为 SDK 特质或账本事实；正例 1/2 次无提示，第 3 次有两个维度各 3 个来源；改写后各 4 个来源；相反内容抑制长度，直接程度保留 4 个支持；实际 prerecall 及旧缓存矛盾检查通过。 |
| v2 整轮状态 | **仍为 `quality_failed`，没有改记为通过**：脚本在撤回阶段误把 `Promise<void>` API 的返回值断言为 true，当时未观察后续风格/遗忘/重启。只读核查已确认 revision 2 的提取、embedding、会话接收三类授权撤销写入；这是脚本契约错误，不据此认定 SDK 风格语义失败。 |

历史失败与中断记录均保留，详见[技术说明](../design-notes/2026-11-03-memory-backend-composition.md)。v2 当时缺少的真实后续控制已由最新独立 VoiceMem 验收补齐，不回写旧报告。这是用户明确要求的两后端分别验收，不是重放旧语料来追求旧报告变绿。两组使用不同语料/步骤，单次约 17.9/90.9 秒不可作后端速度比较，也不给出延迟百分位；音频 transport 仍为 stub，实际 ASR、回答 LLM、TTS 与设备未验收。

## 尚未验收

- 真机 30 轮口述、实际语音延迟及体验；脚本和三个样本不能替代。
- 手机 standalone：保存后新会话读取、重启后的遗忘、Space 切换到 Client 时不合并数据等端到端设备行为。
- iOS 后台/终止/取消/忘记竞态，以及未来备份排除和文件保护的实际效果。主机 Swift mock 不是 iOS 真机；排除新备份不能追溯擦除历史备份、导出或其它副本。
- 本次没有新的 Flutter 全套或设备验收结论，不声称已全部通过。

兼容提醒：iOS 首次升级到新持久授权机制时，可能一次性中断缺少该授权的旧未完成上传，但不会删除已保存的聊天、记忆或工作区。新的备份保护只针对未来备份，不能追溯擦除旧备份。

## 回退

保留原账本及配置的数据路径，停下应用后改为：

```dotenv
MEMORY_CONNECTION=local
MEMORY_RECALL_ENGINE=ledger
MEMORY_EXTRACTORS=ledger
MEMORY_PRERECALL_ENABLED=false
```

移除冲突的 `MEMORY_PROVIDER` 后重启。**不要删除 ledger、手工清理 SDK 文件或重建空库**；旧引擎由既有退役/对账流程处理。回退关闭的是可选 SDK 召回与风格抽取，不是删除已有事实，也不能撤销已经发送或进入历史备份的数据。
