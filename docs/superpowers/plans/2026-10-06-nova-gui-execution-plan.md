# Nova 截图驱动 GUI 执行计划

> 本 chat 最初授权：核查、细化规划并初步实现，从当前隔离工作树的 v0.4.0dev 提交开始。下面六项任务保留为完整路线；本次初步交付聚焦共享 runner 与 Mac computer 接线，其余平台和端到端验收仍按记录推进。未授权合并、推送或发布。

> 2026-10-06 续跑授权：用户要求“都帮我搞完 + 验收”，扩展为执行下面完整路线；缺少可用实机的项目保持未通过，不以 mock 代替。继续禁止合并、推送和发布。

> **For agentic workers:** 使用 superpowers:executing-plans 逐项执行。本计划默认由当前执行者完成，不要求创建子代理。

**Goal:** Nova 通过 Midscene 共用截图规划与定位逻辑，在 macOS、Windows、Android 和 iOS 上调用各自的输入驱动，并保留 Nova 的审批、取消和结果验证。

**Architecture:** 任务层统一；browser、computer、mobile 使用独立的 controller/执行通道和薄执行适配器；Midscene 规划定位循环及可共用的执行生命周期复用。平台设备负责截图及动作；Nova 负责目标绑定、执行授权、生命周期和结果证据。无需 AX/UIA、DOM 或另一套 Python agent。

**Tech Stack:** Node.js / TypeScript；现有 @midscene/core、@midscene/shared；新增与核心兼容的 @midscene/computer；Android ADB；iOS WDA。

**Spec:** 本文件“范围与已确认事实”是本计划的需求依据。

## 范围与已确认事实

- 用户已选择纯截图理解与坐标操作；桌面无需利用原生控件信息。
- 共用模型配置与 prompt 主体；动作说明随平台生成。第一轮用同一款经过验证的视觉模型对比 Mac 和 Android，不要求永久共用模型。
- 执行顺序：核对基线 → 共享循环 → Mac → Android 回归 → 浏览器 → Windows → iOS。
- 2026-10-06 只读检查：主目录在 v0.3.0dev；`.worktrees/v040-gui` 在 v0.4.0dev，HEAD `c0abf248629c4c88c945d96ac5f7e44ba49fef48`，检查时工作树干净。
- v040-gui 已有 mobile.ts、mobile-ios.ts、mobile-android.ts，production-composition.ts 已注册 mobile 并共享审批；因此无需先从旧 autoglm 分支合并这些文件。
- 现有 runtime/package.json 锁定 @midscene/core / shared 1.12.9。mobile-ios.ts 同时承担 Android 和 iOS；模型 family 校验仅接受 auto-glm / auto-glm-multilingual；真实 iOS 当前校验被拒绝，仅允许 simulator。不能把“有 ios 配置项”视为真机支持。
- 当前结果仅有模型结束、动作步数等摘要；新增桌面闭环需补充实际结果观察。模型结束不能证明任务完成。

## Global Constraints

- 推荐从执行时最新的 v0.4.0dev 创建隔离工作树；上述 HEAD 只是调查快照，执行前重新核对。最终合并目标需由用户指定。
- 仅 TypeScript 生产实现；不新增 Python runtime；保留现有 mobile 外部入口和配置兼容性。
- 不重写 Midscene prompt 或坐标协议；不盲目升级全部依赖。先检查 1.12.9 对应 computer 包、公开接口和支持的 model family。
- 使用 Nova 现有 controller、审批和 task verifier；语义路由使用结构化模型调用，不加入关键词分派。
- 写动作均保留现有审批策略。设备/显示器显式绑定，同一桌面输入资源串行；取消后不派发新动作，已派发动作等待有界返回。
- 首版桌面单显示器、正常用户权限、本地执行。多屏默认拒绝，直到显式映射校验通过；不做远程控制、跨设备任务或流程录制。
- 首版保留点击、输入、滚动、快捷键；Android/iOS 保留已有动作。桌面拖动、双击有实际验收目标后再加入。
- 步数和时间预算沿用已有可配置限制；模型 API key 不入日志，截图不默认持久化，用户可选择保存脱敏验收证据。
- 按功能形成少量提交；runtime 和 desktop 构建串行，避免共同 dist 被覆盖。

## 任务、执行器与设备的边界（依据后续用户讨论更新）

三个执行类别不是三个任务系统。沿用 TaskService 的 goal、acceptance、revision、phase、works、evidence_refs 和取消/验证逻辑。execution_route 记录 browser / computer / mobile；不新增 browser-task、computer-task、mobile-task 类型。一个 task 可以顺序绑定不同 work；每个 work 固定一条执行通道、一个目标和对应 session。改变目标需要新的 work，不能在运行中静默改写绑定。

| 层 | 共用/区分 | 实现原则 |
| --- | --- | --- |
| TaskService / task loop / verifier | 共用 | 管目标、验收、修订、控制权和证据；不包含 ADB、WDA、tab 或 DPI 操作 |
| AgentController / executor 通道 | 三个独立入口 | browser、computer、mobile 各自描述能力、选择并校验目标、处理 dispatch/cancel |
| 执行生命周期 | 复用小函数 | 有真实重复时提取审批/预算/进度/结果包装；不创建单实现抽象基类，不复制 MobileExecutor 三份 |
| Midscene runner | 共用 | 截图 → 规划/定位 → guarded actionSpace → 再观察；prompt 主体复用、动作集合分别生成 |
| Device / session | 区分 | browser session/page、PC OS/display、mobile OS/deviceId；使用原有接口和平台驱动 |

第一版维持已配置单目标模式：PC 显式 displayId、手机显式 deviceId、浏览器创建并管理专用 session/page。存在多个候选且用户未指定时澄清，不挑第一台设备。第一版不实现动态多目标池；目标选择的数据入口仍留在 controller，而不是给 TaskService 加平台字段。

browser 也遵循截图与坐标路线：Midscene 看页面截图，Playwright 执行坐标点击、输入、滚动和导航。页面大小等元数据用于坐标映射，不使用 DOM 语义定位。浏览器 session 生命周期、URL 导航和关闭由 browser 后端管理，不能视为桌面后端的一个布尔开关。

资源占用按实际执行方式：Playwright 驱动的 browser 占 browser session；computer 占本机交互桌面的鼠标键盘；mobile 占 deviceId。若某个 browser 后端改成 OS 鼠标操作，必须同时占 desktop 输入资源。复用 task-resources.ts 的资源模型；设备跨进程锁沿用 device-lock.ts，不再增加同类锁系统。

新增路由测试：同一 task 的两个 work 可以分别记录 browser 与 mobile，但 session/证据不得串用；同一 work 不接受目标切换；browser 与 computer 可以并行的前提是前者没有占用 OS 输入；computer 同会话并发必须 busy 或可取消等待。

## Review Focus

- Retina / Windows DPI / 手机缩放：截图像素和输入坐标不同，必须验证映射。
- 审批等待中目标改变：不能将旧坐标直接发送给新的窗口或设备。
- 取消发生在已派发动作之后：不能假装撤销动作，也不能提前释放占用。
- 多任务竞争同一鼠标键盘或手机：第二个任务应返回 busy；连接丢失且写入结果未知应隔离。
- SDK 返回 Finished 或输入非空：不能据此宣布业务成功，需独立结果观察。

## Task 1：确认可执行基线和 SDK 接口

**Files:** 读取 runtime/package.json、package-lock.json、runtime/src/executors/mobile-ios.ts、mobile.ts、mobile-android.ts、runtime/src/composition/production-composition.ts；参考现有 mobile 验收脚本。

**Interfaces:** 消费既有 AgentController、HostApprovalController、AbstractInterface、DeviceAction；产出已验证的版本组合和桌面 screenshot/action API 对照，写入本计划执行记录。

- [x] 创建隔离工作树前检查 AGENTS.md、最新分支、已有适用工作树；保留所有其他工作树。
- [x] 在隔离工作树执行 npm ci，构建 runtime 并跑现有 mobile 测试，记录基线；已有失败先明确归因。
- [x] 核对 @midscene/computer 1.12.9 的包和类型；验证 screenshot、size、actionSpace、输入驱动，以及取消/销毁行为。不能依赖未公开私有方法。
- [x] 若版本不兼容，选最小的兼容 Midscene 版本组合，并先跑移动端回归；不跨大版本直接重写。
- [x] 确認 GUI 模型配置与桌面操作兼容；保留现有已验证 family，新增 family 时使用 SDK 的明确支持列表。

**验收:** 确认截图与坐标动作可以独立调用并被 Nova 包装；未验证的 SDK 能力不得进入后续实现。

## Task 2：抽出共享 Midscene 循环，保持 mobile 行为

**Files:** 新增 runtime/src/executors/gui-runner.ts；修改 mobile-ios.ts；新增 runtime/test/gui-runner.test.ts；保留已有 mobile 测试。

**Interfaces:** `runGui(instruction: string, device: AbstractInterface, options: GuiRunOptions): Promise<{code: string; steps: number}>`。GuiRunOptions 明确包含 signal、modelConfig、maxSteps、budgetMs、settleMs、context、现有 approve/progress 回调，以及用于结果观察的回调。mobile-ios.ts 保留 runMobileIos 对外签名，提供现有设备与经守卫的 actionSpace。

- [x] 写共享循环测试：审批拒绝时动作调用次数为 0；取消等待中的审批后不执行动作；超过预算或步数不再执行动作。
- [x] 仅抽出 Agent 初始化、模型配置、进度监听、aiAct、结束判定与销毁；设备绑定、WDA/ADB 请求和清理保留在平台文件。
- [x] 保留逐动作守卫；shared runner 不提供绕过平台动作包装器的路径。模型 family 的设备无关校验迁移到共用位置。
- [x] 测试模型结束只产出 model_finished，不能直接生成已验证成功；执行期间取消不提前释放资源。
- [x] 构建 runtime，运行 gui-runner 和现有 mobile 测试；确认 Android/iOS simulator 行为与基线相同。

**验收:** mobile 使用同一入口继续工作，共享循环能注入不同设备，未新增另一套模型或 prompt 引擎。

## Task 3：接入 Mac 截图与坐标执行

**Files:** 新增 runtime/src/executors/computer.ts、computer-device.ts；修改 runtime/package.json、package-lock.json、runtime/src/executors/index.ts、runtime/src/composition/production-composition.ts；新增 runtime/test/executors-computer.test.ts、computer-device.test.ts；扩展 production-realtime-assembly.test.ts。

**Interfaces:** `ComputerExecutor` 沿用 MobileExecutor 的 Executor/controller 契约；public descriptor 为 computer，拥有隐藏 computer 通道。重复的执行生命周期用小函数复用，不复制整个 MobileExecutor。computer-device.ts 返回实现 AbstractInterface 的设备，只有经 Nova 审批及目标检查的动作可执行。使用 Task 1 验证的 Midscene 公开接口，不复制截图/输入驱动。

- [x] 注册默认关闭的 computer 配置：目标 displayId、预算、模型配置；沿用项目既有 executor 配置路径。
- [x] 新增截图、坐标点击、输入、滚动和快捷键；Mac 仅启用单显示器目标。不读取 AX 控件树。
- [x] 包装全部写动作：审批 → 重新检查设备、显示器几何和前台应用/窗口身份 → 执行 → 返回新截图。前台身份可用系统元数据，不能据此使用控件语义操作。
- [x] 测试 2x 截图到逻辑坐标的映射、越界和 NaN 拒绝、显示器几何改变拒绝、审批期间窗口身份变化拒绝。
- [x] 复用已有占用锁/审批模式，桌面鼠标键盘按本机会话串行；测试竞争任务 busy、动作返回未知时不自动释放隔离状态。
- [x] 接入 production composition 和现有任务目标选择；语音取消走原有任务取消机制。
- [ ] 在受控桌面任务中验收：打开指定页面/应用、定位输入框、输入中文、点击并滚动、验证最终内容；再验收拒绝及语音取消。

**验收:** 从真实 Nova 入口发出任务，经共享审批和 Midscene 操作 Mac；实际结果截图证明每个要求。直接调用 SDK 的演示不算 Nova 集成验收。

## Task 4：Android 共用链路与结果证据

**Files:** 修改 mobile.ts、mobile-ios.ts、computer.ts 及已有任务证据接线；修改 runtime/test/mobile-midscene.test.ts、executors-mobile.test.ts；复用 runtime/scripts/accept-mobile-android.mjs，新增 runtime/scripts/accept-computer.mjs。

**Interfaces:** 使用已有 task verifier 的观察入口；按当前工作/session/目标关联截图观察和动作结果，不另造成功判定协议。最终截图作为 evidence，模型 finished 作为执行状态。

- [x] 将最终观察接入 verifier。图片经现有视觉验证路径解释；运行结束但证据不足时继续验证或返回待确认。
- [x] 测试：相同任务在两个目标上的证据不能串用；model_finished 但页面未达目标时不能完成；观察失败返回 unknown。
- [ ] 真 Android 使用显式 serial，走 Nova → 共用 runner → ADB；验收图片定位、点击、中文输入和 swipe，而非只验 Home/Back。
- [ ] 对 Mac 和 Android 用同一视觉模型跑同类任务；记录定位失败、重规划、耗时和最终结果，用结果决定是否分别选模型。
- [x] 完成聚焦测试、runtime 全套及 desktop 构建；build/test 串行。报告中分开列出自动检查、模型请求和真设备结果。

**验收:** 两个平台共用循环、动作权限和结果验证，同时保留明确的平台身份。

## Task 5：浏览器执行器

**Files:** 新增 runtime/src/executors/browser.ts、browser-device.ts、runtime/test/executors-browser.test.ts、browser-device.test.ts；扩展 Task 3 的 production composition、导出和依赖接线；扩展 runtime/test/task-dispatch.test.ts 的 work/session 绑定测试。

**Interfaces:** BrowserExecutor 实现已有 ExecutorAdapter/controller 契约，public descriptor 为 browser、拥有隐藏 browser 通道。browser-device.ts 用 Playwright 管理专用 browser session/page 并提供 AbstractInterface；复用 runGui 和实际重复的生命周期 helper。

- [x] 检查项目现有浏览器依赖与会话封装；优先复用，确需新增时选与固定 Midscene 版本兼容的 Playwright 接入。
- [x] 首版专用浏览器会话，固定 page 与 viewport；页面截图及坐标动作，不接管用户已有登录浏览器，不使用 DOM selector。
- [x] 在每个动作前后校验 page/session；处理 page 关闭、viewport 改变、导航失败，观察不足返回 unknown，不自动切换到桌面操作。
- [x] 测试 page 关闭后不执行、坐标映射、取消关闭会话、证据关联；执行三个类别的 work 绑定与资源占用测试。
- [x] 真 Nova 管线验收受控网页输入、点击、滚动和导航；截图证明目标达成，测试拒绝与取消。

**验收:** browser 是独立可调度执行入口，但没有独立 task store、verifier 或第二套截图规划循环。

## Task 6：Windows 与 iOS 平台完成

**Files:** computer-device.ts 及 computer-device.test.ts；mobile-ios.ts、mobile-ios.test.ts；已有 simulator 验收脚本，按真机身份绑定需要补充实现。

- [ ] Windows 实机验收截图、100%/150% DPI 坐标、中文输入、快捷键、取消与缺失权限；所有依赖验证可在安装包内加载。
- [x] 审核 `/dev/null` 日志关闭方式的 Windows 兼容性；继续确保 SDK 不落盘保存原始模型请求、密钥或截图。
- [ ] iOS 先回归 simulator；真机先实现并验证 USB/WDA 与目标设备身份绑定，再解除当前 simulator-only 校验。
- [ ] iOS 真机验收截图定位、tap、中文输入、swipe、设备断连和取消；WDA 可连接不等于任务成功。
- [ ] 每个平台形成可重复验收记录；不可用平台明确保持禁用，不因 Mac/Android 成功而宣布四平台完成。

**验收:** Mac、Windows、Android、iOS 各有独立的真实运行证据；若暂时无 iOS 真机条件，明确交付前三个平台和 simulator，真机项保持未完成。

## 提交与交付

- 提交 1：共享 runner 与 Mac 接入，mobile 回归通过。
- 提交 2：结果证据与 Android 实机闭环。
- 提交 3：浏览器执行器及路由/资源测试。
- 提交 4：Windows 和 iOS 平台完善；可按实际完成平台合并成更少的功能提交。
- 提供测试结果、平台验收证据、已知限制和配置说明；合并/推送不属于本次规划请求。

## 执行前自检

- 用户要求的截图、坐标定位、平台动作、共用模型/prompt 均有对应任务。
- 五类主要失败条件在 Task 2–4 有明确测试与拒绝/unknown 行为。
- 不将旧记录的真机验收或当前源码接线当成此次端到端成功。
- 初步实现和检查结果见下面执行记录；自动测试不等于真实模型或设备验收。


## 2026-10-06 执行记录与适用调整

- 起点：本工作树 `/Users/fishwowater/.codex/worktrees/7885/nova-audio-agent`，detached HEAD `c0abf248`，与 `v0.4.0dev` 相等；工作树干净。未修改其他工作树或使用主目录 v0.3.0dev。
- 基线：锁定依赖安装完成，既有 mobile/Android/iOS/设备锁聚焦检查 37/37 通过（本地脚本模型与伪 ADB，不是真实设备）。受限环境的 localhost/process EPERM 重跑后消除。
- 版本：npm 公共包 `@midscene/computer@1.12.9` 与 core/shared 1.12.9 匹配；读取安装 tarball 的公开类型与实现。未升级 Midscene。
- 共享 runner：提取 Agent 配置、视觉规划、进度与结束状态；平台守卫保留审批、目标、步数、预算和回执。MobileIosConfig/runMobileIos 保持兼容。日志路径改为 Node `os.devNull`。
- 执行生命周期：MobileExecutor/ComputerExecutor 用组合复用已有 reservation、host approval、deadline、设备锁与 handoff 实现，没有抽象基类或另建任务系统。共享具体 lifecycle 的范围仅限这两条真实重复链路。
- Mac 接线：`EXECUTORS=computer` 显式启用；要求 COMPUTER_DISPLAY_ID 与 GUI 模型配置。仅 Mac/单显示器。显示器/几何/前台 PID、bundle、CGWindow ID/位置在截图和审批前后核对；不读取 AX 树。已授权动作切换前台窗口后允许重新观察；work 固定的是 display/session，并非永远固定一个窗口。
- SDK 调整：connect 会移动并恢复鼠标，因此单独经过 HostApproval。SDK Tap 可能自动补点；用其已安装的公共 libnut MouseAction 执行单次点按。Input 仅向当前焦点追加，KeyboardPress 不隐式聚焦，Scroll 限于单次且距离不超过屏幕。截图/输入 SDK 放入本任务独立子进程，避免同步原生调用阻塞 Nova 取消/预算；进程组记录到现有锁以防 host 崩溃后抢占。
- 安全检查：拒绝或未知写入锁存为终止状态；Midscene 捕获错误重规划也不能再派发动作。写入等待有界回执，超时/断连保持 cleanup_unknown 与锁隔离。SDK 截图等待可取消。模型 Finished 保持 verified=false/effects=unknown，不宣称业务任务成功。
- Mac 元数据：只读实测验证 NSWorkspace/CGWindowList/NSScreen 返回前台窗口与单显示器逻辑尺寸。后续已发起真实 SDK/模型验收，结果见下；Nova 语音任务端到端操作仍待验收。
- Retina 检查：真实 1.12.9 planner 加本地脚本模型验证 400×600 截图映射到 200×300 逻辑坐标 [100,150]；AutoGLM 滚动像素距离 600/3=200，均只缩放一次。

### 后续模型协议审查与实机记录

- Midscene 是共用截图规划/执行框架；AutoGLM 是旧移动端所配置的模型协议。Mac 实机使用 Midscene + Qwen3-VL；没有调用旧 AutoGLM Python executor。新增 family 依据已安装 SDK 的 Qwen3-VL adapter，mobile 保持原有 family 限制。
- 用户授权后通过本地 Claude CLI / claude-sonnet-5-5 审阅代码和计划；核对建议后补充进程退出确认、部分写入后的 unknown 结果，以及 Qwen 完成协议回归。Qwen 标准 complete 返回不能沿用 AutoGLM 的 Finished action 判断。
- model_finished 统一作为 unknown/verified=false 返回，避免桌面进度将它显示为任务已完成；执行过动作后拒绝或屏幕变化同样返回 unknown。
- 首轮 Safari 本地页真实模型验收：输入中文成功、滚动返回，确认和完成按钮未达成，5 步后 model_failed，未通过。第二轮无动作即 model_failed。第三轮前台离开测试页，模型点击 Dock 后 action_failed，未通过。后续用户将 Safari 测试页置于前台继续验收。
- 实机入口使用 ComputerExecutor controller/dispatch 和共享 HostApproval、目标守卫、设备锁；这覆盖执行器集成，不代替 Nova 语音入口和 task verifier 的最终验收。

## 下一项验收（尚未完成）

1. 从 Nova 实际入口执行受控 Mac 任务：中文输入、点击、滚动、快捷键、拒绝与语音取消；确认权限与打包输入驱动。
2. 接入最终截图的现有 task verifier，并以 work/session/display/device 绑定结果证据；不把动作步数当作结果达成。
3. 真 Android 共享链路与同款视觉模型对比；iOS simulator 本地 WDA 回归。
4. browser 独立 controller/专用 Playwright session 与坐标适配，复用同一 planner/lifecycle；扩展 task-resource/work-evidence 绑定测试。
5. Windows 与真实 iOS 独立平台实现和实机验收；目前保持禁用，不从 Mac/mock 推断支持。

## 2026-10-07 完整续跑记录

共享截图 runner、browser/computer/mobile controller、任务目标/会话绑定、实际图片验证、Windows guardian 接线与真实 iOS USB 身份路径已实现。新版执行结果由既有 TaskVerifier 判定；不使用额外 aiAssert，也不把 model_finished/outcome ok 作为业务完成。当前各平台实测与未通过项以 [验收记录](../../verification/gui-execution-2026-10-07.md) 为准；上面的 10-06 初步记录保留为历史，不代表最新实现。未合并、推送或发布。

2026-10-07 验收边界：勾选表示已实现并有自动/已记录实测证据；Task 3 完整 Mac 写入/滚动及麦克风取消、Task 4 真 Android 同模型对比、Task 6 Windows/iOS 物理验收仍未完成。mobile 已通过共享 SDK family 校验支持 Qwen3-VL，替代前一日记录的旧 family 限制；旧 AutoGLM 协议仍保留。最终数据见 docs/verification/gui-execution-2026-10-07.md。
