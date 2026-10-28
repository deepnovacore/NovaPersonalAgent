# 第一批实施与验证记录

日期：2026-10-23。基线 `5652030e`，工作分支 `v1.1.0dev`。本记录对应未提交工作树，不虚构实现 commit SHA。

## 已交付范围

新增独立 workspace `relay/`：协议边界、SQLite 持久信箱、短时实时投递内核、隔离测试脚本、包说明；更新根 package/lock 接线。新增同目录 implementation-plan 与 preflight，核实 V1/V2/V4/V5，记录 V3 删除阶段尚未退出。没有改旧 runtime、Hub 或 Flutter 产品行为，没有删除旧代码，也没有网络服务部署。

两个实现 agent 分别负责 mailbox/live；主 agent 负责公共协议、接线、联验、边界修复和证据。一名 `fork_turns=none` 的全新上下文 reviewer 独立阅读设计和最终变更，完成一轮审查，未继承实现讨论。

## 测试结果

环境：Node `v24.19.0`，仓库安装的 TypeScript。用户明确允许本次在云环境 `/workspace` 使用任务隔离输出，替代不存在的本地外置盘。

| 检查 | 结果 |
|---|---|
| `npm run test:relay -- --output-root /workspace --run-id space-host-client-root` | 33/33：mailbox 16、live 14、protocol 2、delivery 联验 1 |
| `npm run check:relay` | 通过，含 strict/noUnused 等仓库配置 |
| `npm run typecheck --workspace @nova-personal-agent/runtime` | 通过 |
| runtime 隔离编译 | 通过；outDir/tsBuildInfoFile 指向本轮目录，不调用 clean |
| 既有 `hub-routing.test.js` | 2/2 |
| 既有 `hub-server.test.js` | 2/2 |
| 既有 `hub-life.test.js` | 6/6 |
| 既有 `hub-pairing.test.js` | 5/5 |
| 既有 `space-authority.test.js` | 4/4 |
| `git diff --check` | 通过 |

既有测试合计 19/19，不代表运行了全仓测试。HTTP 测试首次受沙箱 `listen EPERM 127.0.0.1` 阻断；允许本地测试网络后重跑通过。未修改测试去绕过断言。

Relay 输出位于 `/workspace/nova-relay-676ebe8777b2f935/space-host-client-root`；runtime 输出位于 `/workspace/nova-runtime-676ebe8777b2f935/space-host-client-root`，编译命令：

```sh
node_modules/.bin/tsc -p runtime/tsconfig.json \
  --outDir /workspace/nova-runtime-676ebe8777b2f935/space-host-client-root \
  --tsBuildInfoFile /workspace/nova-runtime-676ebe8777b2f935/space-host-client-root/.tsbuildinfo \
  --declaration false --declarationMap false --sourceMap false
```

输出目录仅补充 `type: module` 的 package.json 和指向现有依赖的 node_modules 链接，然后逐文件直接执行 `node <output>/test/<test>.js`，输出真实子测试数量。无模型/API/推送调用。

## 审查发现与修复

独立审查发现 1 项 P2、无实证 P1：尚未交付的消息被显式清理后，快照恢复到最新 floor，但没有后续新消息时，read(after:floor) 的空页不推进 delivered；ACK floor 被拒绝，重连默认读取反复 cursor_expired。

主整合也复现了此问题。新增 `empty recovery page delivers the retained floor for durable ACK after snapshot`，先失败，再修改为成功读取时只要 nextCursor 大于 delivered 即推进，空页同样适用。保留 read/ACK 不得跳到未知未来游标的约束，并验证重启后 ACK 持久。

Reviewer 的测试发生在该回归测试 RED 阶段，未声称审查者复验修复。修复后由主 agent 完整运行全部 33 项、类型检查和 diff 检查，均通过。没有要求第二轮独立审查。

## 结论与下一步

**只完成 M1 第一片投递内核，不满足 M1 全部退出标准。** 当前测试 authority 是替身，不是密码学实现；Base64 不证明 E2E，签名验证和设备身份必须由后续可信适配器完成。

下一片应先确定并评审成熟配对/E2E 方案及设备成员/epoch 存储，再接网络 transport、准入和 Docker。信箱去重历史有硬上限、用尽拒绝新 ID；上线前须完成 namespace/replay-window 生命周期与运维恢复，不能删除历史后复用同一命名空间。SQLite 多进程并发负载尚无测试证据，当前仅依赖事务串行化机制。

M0/M6 仍需账号、证书、iPhone/GMS Android/小米真机。M2–M5 仍需 Host 唯一 Life 权威、Space 隔离、持久意图、流式聊天端到端接线，不能把内核联验称为“模型仅调用一次”或“锁屏已到达”。旧代码保留，后续替换通过验收后再建备份分支并删除。
