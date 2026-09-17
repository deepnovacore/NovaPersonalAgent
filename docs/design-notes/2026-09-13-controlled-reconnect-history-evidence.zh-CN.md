# 受控重连与历史恢复：保留范围与历史依据

> 2026-09-13 调查记录。结论已并入 [瘦身计划](2026-09-13-slim-plan.zh-CN.md) 的"明确不动"一节；本文只保存证据，不是待办。

## 功能区分

- Guard 监控提醒正常运行。
- controlled reconnect 仅在取消被拒绝等严格条件下更换 provider 会话。
- history recovery 给替换后的会话补最近对话，不承担一般任务恢复。

关闭时提醒仍排队，用现有 deadline 隔离旧音频，但不会强制释放 provider 推理占用；等待 provider 终结、用户不在说话后再播。provider 永不终结时，这条路径无法保证提醒最终播出。

## 默认值历史核查

使用 `git log --all -S/-G` 核对本地可达历史（当时 132 个 refs），**未找到产品默认 true 的版本**：

| 日期／提交 | 证据 | 结论 |
| --- | --- | --- |
| 2026-08-16 `c87fdd62` | Python config.py:36–38、service.py:225–226 | False / none；assembly 测试明确命名 opt-in |
| 同一提交 | scripts/realtime_probe/history_recovery.py:267–269 | 实验脚本显式 True，不是默认 |
| 2026-08-19 `27e97cd8` | 初始 TS service | `?? false` / `?? 'none'` |
| 2026-08-20 `b4aa5287` | TS assembly | 仅转发调用方提供的值 |
| 2026-08-20 `eca04657` | TS config | `.default(false)` / `.default('none')` |
| 2026-08-22 `0ecdcaa0` | .env.example | 新增注释 false，不是生效的 true 覆盖 |

当前代码：`runtime/src/config.ts:91` 的 `qwen_guard_history_recovery` 默认 `'none'`，`environment-contract.ts:84` 对应 env 默认 `none`。

历史提交 `40103b9c` 将受控换会话描述为最后手段；当前七条件防止替换已经产生内容的正常会话。未找到"效果评估证明无用"的结论，也没有据此证明真实 Qwen 取消拒绝链路已经验收。

范围限制：最早可达根提交已经默认关闭，不能推断导入历史之前从未开启；未调查未提交的私有环境设置或不可达对象。实验显式开启与产品默认必须分开。

## 结论

暂不退役这条路径。后续价值判断需要实际触发次数、取消失败后等待时间、恢复成功率和上下文影响。

## 附：协议预检定向测试记录

2026-09-13 针对主目录源码运行 32 项定向测试（schema 16、transport 9、host 7），均通过；使用临时 loader 与假 runner，不构建共享 dist，不运行真实模型。它们证明当前预检边界成立，不证明瘦身计划批 7 中尚未实施的"同次建立流程复用认证"方案已经通过。
