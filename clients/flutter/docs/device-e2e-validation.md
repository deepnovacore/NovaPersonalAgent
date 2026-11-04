# 设备文档端到端验收（2026-11-04）

> 注：文中链接的 `evidence/` 原始验收证据（设备报告、截图、输出 PDF、日志）因含第三方论文全文及大量重复运行副本，未随公开分支发布；
> 保留在 `feat/cjk-pdf-default-font` 分支历史中，文档中的数字与哈希仅作记录。
> Note: the `evidence/` files linked below (device reports, screenshots, output PDFs, logs) are not part of the public tree; they remain on the `feat/cjk-pdf-default-font` branch.

**结论：不能宣称两台真机端到端验收通过。** iPhone 真机因免费开发签名安装名额已满
blocked；经协调批准改做独立 iOS 模拟器补测。小米真实模型最后一轮 A 中文乱码、
B 有虚假阅读覆盖声明、B2 有不存在的引文，均 FAIL。模拟器 A/B 也有失败；
模拟器 B2 的结构化解读及抽查引用通过，但不是 iPhone 真机证据。

**后续（修复中文方块之后）**：见“中文方块根因与修复（2026-11-04 续）”。下面“最终一轮结果”等表格是修复前的
原始结果，不改写。修复后只在 iOS 模拟器补测（A 共 6 次、5 过 1 败，样本很小），小米真机和 iPhone
真机仍然**未执行/blocked**，仍不能宣称两台真机端到端验收通过。

只用授权 `e2e-materials` 中的合成工作簿和两篇公开论文；未读取 `~/Downloads`。
未 push，未改 Feeds/Host 协议、未修基线无关的9个失败测试。

## 设备、安装与隔离

| 环境 | 系统/设备 | 独立验收包 | 安装方式/结果 |
|---|---|---|---|
| iPhone 真机 | fishwowater的iPhone / iPhone13 Pro / iOS27.2 / UDID `00008110-001A19563A39801E` | `com.nova.novaMobile.thinkingAcceptance` | devicectl install：签名构建成功，但安装被拒；A/B未运行 |
| Android 真机 | houji / Xiaomi23127PN0CC / Android14 / arm64-v8a | `com.nova.nova_mobile.autonomy`，最终标签 **Nova Accept** | `adb install` / `install -r`，最终轮只卸载自己先前安装的包后全新安装 |
| iOS **模拟器** | 本会话新建 iPhone15 / iOS27.2(24B8117) | `com.nova.novaMobile.thinkingAcceptance` | simctl install；UUID `FFE715B8-A30B-4637-A2C3-5E47F56E9BC4` |

所有 adb 均明确 `-s adb-be785274-jcY7q3._adb-tls-connect._tcp`；另一无线 transport
仅只读 getprop 验证同一 serial `be785274`，不操作 emulator-5580。
安装前确认 autonomy/thinkingAcceptance 包不存在。没有安装、更新、卸载或清数据用户的
`com.nova.nova_mobile`、`.internal`、theme/relay acceptance、`com.larus.nova`，
也没有碰 iPhone 的日常 Nova/内网版或 AvatarForcingLab。
日常 Android 包13:54:54的更新不是本任务操作；本任务首次 autonomy 安装在13:55之后。

### iPhone 签名阻塞与保留工件

最初新 ID `com.nova.novaMobile.acceptance` 及对应扩展自动签名报无账号/profile。
协调确认 `2FG68QSZSR` 是证书名编号，实际 team 为 **9A32786S6Z**。
采用已有 thinkingAcceptance profile，**仅会话输出 ios-app 副本**移除嵌入扩展与推送
entitlements；Manual 因 Xcode-managed profile 被拒，改 cached Automatic 后构建成功。
没有改仓库产品签名配置。用户随后登录Xcode账号，但设备安装名额仍是硬限制。

安装失败原文要点：`MIInstallerErrorDomain 13 / ApplicationVerificationFailed`，
“This device has reached the maximum number of installed apps using a free developer profile”，
占位的三个 ID 为 `com.fishwowater.AvatarForcingLab`、`com.nova.novaMobile`、
`com.nova.novaMobile.internal`。**没有卸载这三个中的任何一个**。
经协调决定停止安装，不要求用户腾名额/付费；未将模拟器当真机通过。

最终提示版本的已签名真机工件仍保留在受限会话目录（含验收构建期凭据，勿分发）：

```sh
SESSION="$HOME/Library/Caches/nova-build/f289c529c78f/device-e2e-worker-20261104"
# 仅供用户以后自行腾出名额且profile仍有效时补测；本任务没有再次执行此安装。
xcrun devicectl device install app --device 00008110-001A19563A39801E "$SESSION/ios-derived/Build/Products/Debug-iphoneos/Runner.app"
```

现成 profile 到期2026-11-05，之后须重新签名；不能保证旧工件继续可装。

## 驱动、模型及运行时

- 入口：[device_e2e_acceptance.dart](../test/support/device_e2e_acceptance.dart)。
  真实 AgentCoreHost + 四工具 ToolRegistry + 原生 Linux；iOS 使用与UI相同的
  IosModelClient，Android使用ModelClient。界面直接渲染产品 LocalChatPanel。
- 用 [device_e2e_materials.py](../tool/device_e2e_materials.py) 将指定三文件嵌入
  ignored/session文件，不提交论文或原始工作簿。调用UI同一个 `importDocument`，
  导入 `/workspace/inbox/<id>/<name>`；发送UI同样的附件路径/不可信内容消息格式。
  用户指令始终为“帮我汇总表格数据（按城市统计总额），并写出一个 PDF”与
  “帮我解读一下这篇 paper”，未追加引用要求到用户消息。
- 模型：已有 Qwen preset，**qwen-plus**，标准 DashScope compatible endpoint；
  只使用 **DASHSCOPE_API_KEY**。内存 ModelSettings override，不保存凭据到设备
  credential/keychain store。仅验收构建期 dart-define 传入，未传入guest shell环境。
- 首轮 fixture additionalContext 曾要求论文页码；模型忽略。重测已移除此验收专有
  引用提示，仅保留不安装包/下载字体的授权边界。产品文档提示负责引用要求。
- Android PRoot/烘焙工件从已核验缓存复制到本会话目录；iOS iphoneos iSH库重新构建，
  pinned Docker镜像缺失时先在主机pull，再由baker离线安装；模拟器库由相同源码的
  已验缓存复制。最终rootfs tgz：Android
  `d127d5e2e6760dce05e546ce94e9637e17617ffda514ec6f948bcf8ce60732fb`，iOS
  `f5ccd1950df63ebe4d9bdfe6ede91406320ad9c9774a0c1bc7a07c7e1fa35023`。
- 输出/缓存全在内置盘会话目录：独立Flutter SDK、pub/Gradle、插件build、tmp、
  `.dart_tool`、build、DerivedData和编译器cache。没有清理共享目录或写外置盘。
- iSH无JIT，模拟器/PRoot性能不能相互替代，也不能推导iPhone真机耗时。

## 最终一轮结果

每条 shell 的**耗时/退出码/状态/完整命令与stdout/stderr**均保留：
[完整计时表](evidence/device-e2e/shell-timings.md)、
[Android最终JSON](evidence/device-e2e/android-final-report.json)、
[iOS模拟器最终JSON](evidence/device-e2e/ios-simulator-final-report.json)。
`Finished`/`completed`只代表循环结束，不代表验收通过。

| 环境 | 用例 | 模型循环总秒 | shell次数 / 累计秒 | 严格结果 |
|---|---|---:|---|---|
| iPhone真机 | A/B | 未运行 | 未运行 | **BLOCKED**，签名安装配额 |
| 小米真机 | A | 81.554 | 9 / 6.900 | **FAIL**，数字正确但中文PDF全为方块，未嵌入中文字体；UI导入/chip/chooser通过 |
| 小米真机 | B / 13页 | 43.276 | 2 / 1.066 | **FAIL**，有正确页码但虚假“全部完整读取”声明，部分引用无依据 |
| 小米真机 | B2 / 11页 | 117.652 | 10 / 3.823 | **FAIL**，结构化/有引用，但伪造了论文中的用户原话 |
| iOS模拟器 | A | 111.631 | 7 / 35.866 | **FAIL**，正文中文可读但表格城市/表头为方块；未手测分享 |
| iOS模拟器 | B / 13页 | 84.003 | 4 / 32.361 | **FAIL**，所引主要事实抽查正确，但有虚假全文阅读/覆盖声明 |
| iOS模拟器 | B2 / 11页 | 243.277 | 15 / 128.823 | **PASS（引用抽查范围）**，不超时、结构化、至少4处引用与原页一致；回答语言错误地变为英文，未声称语言策略通过 |

所有实际执行shell都没有 `timed_out`；非零退出包含模型Python语法错误、缺输出目录
等，均留原始stderr。PDF独立核验shell不计入模型循环：Android0.793s/exit0，
iOS模拟器8.241s/exit0。iOS shell次数包含一次本地拦截安装请求，非实际执行安装。

### A：金额、中文与字体

主机独立openpyxl核验240行、总额185222，与expected.txt一致；文件哈希见
[host-material-check.json](evidence/device-e2e/host-material-check.json)。
下表是agent脚本实际统计值；最终PDF的中文标签不可读，**不能仅凭数字一致判通过**。

| 城市 | expected | Android统计 | iOS模拟器统计 |
|---|---:|---:|---:|
| 上海 | 41258 | 41258 | 41258 |
| 广州 | 40469 | 40469 | 40469 |
| 北京 | 40103 | 40103 | 40103 |
| 成都 | 34662 | 34662 | 34662 |
| 杭州 | 28730 | 28730 | 28730 |
| 总计 | 185222 | 185222 | 185222 |

设备与主机都用pypdf读回；主机还用pdftoppm渲染并实际检查图像：
[Android方块PDF](evidence/device-e2e/android-final-summary.pdf) /
[截图](evidence/device-e2e/android-final-summary.png)，
[iOS表格方块PDF](evidence/device-e2e/ios-simulator-final-summary.pdf) /
[截图](evidence/device-e2e/ios-simulator-final-summary.png)。
[主机读回文本/字体/文件哈希](evidence/device-e2e/host-pdf-checks.json)。

- 烘焙字体实际存在，SHA256两端均
  `88f7c79e5b9b132c8b455ad2ff8e943d36b5f65aef653c6327e604646f0617e9`。
- Android最终只用Helvetica/Helvetica-Bold/ZapfDingbats，全文读回`■■`，不是rootfs缺字体。
- iOS正文嵌入`/AAAAAA+NovaDocumentSansSC-Regular`且可读“上海”，但ReportLab表格
  未设置中文FONTNAME，仍用Helvetica；**仅发现“上海”不足以证明全文中文正确**。
- 不人工修模型生成脚本/PDF来过关。此问题在提示两次调整后仍存在，停止迭代。

### B/B2：阅读范围、引用抽查与编造

主机pypdf逐页提取13页VoiceAgentRAG与11页Talker-Reasoner，核对实际PDF页号（非章节号）。
逐项原文短摘见 [citation-checks.json](evidence/device-e2e/citation-checks.json)。

| 轮次 | agent引用/主张 | 主机原文所在PDF页 | 核查 |
|---|---|---|---|
| Android最终B | 文档嵌入而非查询嵌入(p.4) | 4 Semantic Cache | 一致 |
| Android最终B | 75%/150/200、316×(p.7) | 7 Table1 | 一致 |
| Android最终B | τ0.30=90%、τ0.40=75%(p.9) | 9 Table4 | 一致 |
| Android最终B | ASR/TTS局限(p.6,p.12) | 6讲LLM生成500–8000ms；12为参考文献 | 所引页无该作者局限论述；未标成个人推论 |
| iOS模拟器最终B | 文档向量缓存(p.4) | 4 | 一致 |
| iOS模拟器最终B | 150/200、75%/79%(p.7) | 7 | 一致 |
| iOS模拟器最终B | 需要3–7s轮间隔、<2s收益下降(p.9) | 9 | 一致 |
| Android最终B2 | context反馈而非RL更新所有计划(p.3) | 3 | 一致 |
| Android最终B2 | Concat(utterance,belief,history)(p.6) | 6公式2 | 一致 |
| Android最终B2 | 用户原话“thank you, but I can’t do yoga before bed”(p.8) | 8实际是请求加入放松声音；11页全文没有yoga | **伪造引文** |
| iOS模拟器最终B2 | 尚未建模beliefs about beliefs(p.3) | 3明确future work | 一致 |
| iOS模拟器最终B2 | Talker/Reasoner通过memory交互(p.5) | 5 Figure3后说明 | 一致 |
| iOS模拟器最终B2 | Gemini1.5 Flash睡眠教练(p.7) | 7 Section4.2 | 一致 |
| iOS模拟器最终B2 | snap judgement、planning需等待Reasoner(p.8) | 8 Discussion | 一致 |

Android最终B的脚本虽然遍历13页，实际每页只输出前15行，每行最多100字符；
stdout12111字符，而13页全文30927字符。回答却声称“全部13页，无跳过、无截断，未读无”。
iOS最终B先取p1/p2前1000字符，后每页只取匹配标题后的20行，又误把p13系统配置
标为Conclusion；回答仍声称“全部13页、没有遗漏”。两者均未真实披露未读内容，不能通过。

Android B2多次取每页前700字符，误以为p8结论缺失；主机原文p8确有Conclusions。
iOS B2反复回读p6/p7/p8全文、找到Discussion/Conclusions，最终区分正文p1–8与参考文献
p9–11；抽查未见上述Android式伪造引文。此PASS不是全论文每个句子的穷尽事实审计，
也不是iPhone真机通过；其英文答复偏离用户语言，另列为未修问题。

## 中文方块根因与修复（2026-11-04 续）

以下是上面“最终一轮结果”（修复前）之后的补测。上表保留原样，不改写。

**根因**：烘焙镜像里字体一直存在，但模型写的 ReportLab 脚本没有注册它，表头/正文
走默认 `Helvetica`/`Helvetica-Bold`，这些标准字体没有中文字形，所以读回全是`■`。
提示词两次要求“自己注册字体”都不可靠（模型常忘了给表格 `TableStyle` 设 `FONTNAME`）。

**修复（均已提交）**：

1. `29433ad6`：rootfs 装系统 `sitecustomize.py`（`nova_sitecustomize.py`），在第一次
   `pdfmetrics.getFont` 时把内置 TTF 注册成 `Helvetica`、`Helvetica-Bold`、
   `Helvetica-Oblique`、`Helvetica-BoldOblique`（延迟注册，避免 canvas/platypus 循环导入；
   字体不存在则不做任何事；失败只写一行 stderr 警告）。产品提示/文档只说明“默认字体已指向
   内置中文字体，不要下载/安装字体；保留字体缺失如实告知和 pypdf 读回检查中文”。
2. `3b179231`：本验收的判据加强：读回须含五个城市中文名、不含`■`，且含中文的文字
   所用字体必须已嵌入。
3. **钩子自身的第二个缺陷与修复 `78250476`（本轮发现）**：`reportlab.platypus.paragraph`
   用 `from pdfmetrics import getFont` 按名字导入，钩子的延迟包装函数因此一直可达；
   旧实现每次调用都会重新注册4个 `TTFont`。宿主机复现：30 段落+1 表格，旧钩子
   **700 次 `TTFont` 构造/6.4–8.6 秒**，修复后 **4 次/0.04 秒**
   （[旧](evidence/device-e2e/cjk-default-font-20261104/rebake-register-once/host-old-hook-registration-count.txt)、
   [新](evidence/device-e2e/cjk-default-font-20261104/rebake-register-once/host-fixed-hook-registration-count.txt)，
   脚本同目录）。iSH 无 JIT，慢几十倍，脚本超过 shell 默认 60 秒被杀。修复为“只注册一次”；
   新单测对旧代码**失败**、对新代码通过；烘焙 smoke 现在断言 30 段落文档恰好 4 次构造。
   旧钩子的两次 iOS 模拟器 A 失败原样保留于下表。

字体字节、字符集、字重、批准哈希均未改变（`88f7c79e…17e9`）。钩子哈希变为
`ad54aaa3f008f6f6602952febe9c7d1f35d2a3c39ddbeaf973311bf1696a055e`；两个平台均重新烘焙，
各**两次独立构建**归档/文件清单哈希一致，烘焙 smoke（canvas、platypus、pdfmetrics 三种首个
导入顺序，朴素 Paragraph+`Helvetica-Bold` 表头+四个 canvas 别名）通过，13 项主机单测通过：

| 平台 | 新 rootfs.tgz SHA-256 | 复现构建 |
|---|---|---|
| iOS（Alpine 3.21.0） | `08ec30721c6e441dfdd5a5e460f198a226f7be7c62c276c323abfbe19ef6d143` | 2次一致 |
| Android（Alpine 3.22.2） | `4ca0d98938f0829af15732ed6b089f454ed5eeb91ff4b42237439bc21410023c` | 2次一致 |

证据：[rootfs/smoke/修复前后对比](evidence/device-e2e/cjk-default-font-20261104/)
（首版钩子的 rootfs 与烘焙 smoke）、
[重烘焙后](evidence/device-e2e/cjk-default-font-20261104/rebake-register-once/)。
路径已脱敏为 `<repo>`/`<session>`。旧 rootfs 不迁移，只有新烘焙/新安装才有钩子。

### iOS 模拟器 A（真实模型 qwen-plus，每次新装应用，iSH 无 JIT）

- 复用本会话的 iPhone15 模拟器（UUID `40C58B42-D4FA-4B3C-8AD9-CDA975409ED8`，iOS27.2），验收包
  `com.nova.novaMobile.cjkAcceptance`，每次先卸载再安装以清空工作区，因此各次相互独立。
  只有该验收包的进程；别的会话模拟器及进程未触碰。
- 用户指令原样“帮我汇总表格数据（按城市统计总额），并写出一个 PDF”；fixture 的附加上下文
  只有“不装包/不下载字体，用烘焙库/字体，缺失则报告”，**没有字体/引用提示**。
- 判据（不放宽）：总额 **185222** 与五城市小计（上海41258 广州40469 北京40103 成都34662
  杭州28730）；pypdf 读回含“上海/广州/北京/成都/杭州”且无`■`；含中文的文字字体已嵌入；
  主机 pdftoppm 渲染后目视检查。设备内验证脚本与独立主机验证都执行，两者一致。
- 每次结果在 [evidence/device-e2e/cjk-default-font-ios-sim-20261104/](evidence/device-e2e/cjk-default-font-ios-sim-20261104/)
  下（`*/run-N/`：设备报告 JSON、模型脚本、PDF、PNG、`host-verification.json`）。

| 运行 | 钩子 | 模型循环秒 | shell 次数/累计秒/最长单次秒 | 模型脚本的字体用法 | 严格结果 |
|---|---|---:|---|---|---|
| old-hook/run-1（前任务者中断前遗留） | 旧 | 145.0 | 7 / 85.1 / 60.2 | 默认 Helvetica | **FAIL**：生成脚本被 60 秒默认超时杀（exit 137），无 PDF，`tool_timed_out` |
| old-hook/run-2 | 旧 | 117.7 | 2 / 73.3 / 60.2 | 自注册 `Nova` 并用于所有样式（连自注册的脚本也被旧钩子拖慢） | **FAIL**：同样 60 秒超时（exit 137），无 PDF |
| fixed-hook/run-1 | 新 | 114.7 | 4 / 50.7 / 23.1 | 全默认 Helvetica/Helvetica-Bold | **FAIL（判据）**：中文/字体嵌入/无■/五城市小计均正确，但 PDF 与最终回答**都没有总额 185222**；设备内验证 exit 1，主机 `total_185222=false`。是 agent 输出缺总额，不是字体问题，**不当通过** |
| fixed-hook/run-2 | 新 | 117.3 | 3 / 76.1 / 31.9 | 全默认 Helvetica | **PASS** |
| fixed-hook/run-3 | 新 | 178.5 | 9 / 107.3 / 27.4 | 全默认 Helvetica | **PASS**（最长的一次 shell exit 1，模型后续恢复并最终生成正确 PDF） |
| fixed-hook/run-4 | 新 | 119.8 | 5 / 67.5 / 26.3 | 自注册 `Nova` | **PASS** |
| fixed-hook/run-5 | 新 | 136.0 | 5 / 68.1 / 27.3 | 自注册 | **PASS** |
| full-b/run-1 的 A 阶段 | 新 | 111.0 | 6 / 52.0 / 22.7 | 自注册 | **PASS** |

汇总（修复后钩子，全部独立 A 运行，不挑选）：**6 次中 5 次通过、1 次失败**
（失败原因是 agent 漏写总额，另案）；旧钩子 2 次均因 60 秒超时失败。
“全默认 Helvetica”的 3 次（fixed run-1/2/3）直接证明钩子对朴素脚本生效：中文表头与正文都
嵌入 `/AAAAAA+NovaDocumentSansSC-Regular`、无方块；其余 3 次模型自行注册字体，不能单独证明钩子。
通过的 5 次人工目视渲染图：标题、表头、五城市名全部可读，无豆腐块。没有人工修改模型的脚本或 PDF。
所有运行都没有被拦截的装包尝试，没有下载字体；单次 shell 仍达 22–32 秒（冷启动的
 openpyxl/ReportLab 导入），离 60 秒默认超时不远，**这是 iSH 性能余量风险，不是已解决的问题**。

### iOS 模拟器 B/B2 无回归抽查（非通过标准）

同一份最终应用（A_ONLY 关闭）全量跑一次：A（上表最后一行）、B 149.1 秒（13 页论文，
4 个 shell）、B2 131.8 秒（11 页论文，5 个 shell）。三例均循环完成、无工具超时、无错误，
B/B2 回答含 `(p.N)` 页码和“已读/未读页”披露。**没有逐条核对其引用，也没有重新判定
阅读覆盖**：B 仍有“全文核心内容已 100% 覆盖”这类过强声明，B2 称 p.3 只“快速扫描”，
阅读覆盖问题已是另案，本任务不处理。只证明钩子没有让 B/B2 崩溃或超时。

同一验收包/模型/提示在不同运行之间有随机差异（上表已有体现：脚本写法、是否自注册字体、是否写总额都不同）。

**结论（不夸大）**：中文方块的根因链路已打通。iOS 模拟器上修复后 6 次独立 A 运行中没有任何一次出现方块或
未嵌入中文字体，5 次按全部判据通过、1 次因 agent 漏写总额失败。**样本量很小（6 次）、模型有随机性，不能说成“稳定通过”
或 5/6 的通过率保证**；也不能从 iOS 模拟器推导 iPhone 或小米真机结果。

### 小米真机和 iPhone 真机（本轮未执行）

- **小米真机：BLOCKED，未运行**。本轮全程 `adb devices -l` 只能看到别人的 `emulator-5580`（未触碰），
  小米无线调试已断开，用户尚未重连/解锁。上轮还曾因息屏出现 `INSTALL_FAILED_USER_RESTRICTED`。
  本轮没有向手机发送任何唤醒/解锁/触屏输入，没有尝试安装，也没有连接 mdns 中偶现的不明设备。
  已准备完成的工件（含模型凭据，留在权限 700 的会话目录，不可分发）：
  `$SESSION/NovaAccept-fixed-rootfs.apk`（包名 `com.nova.nova_mobile.autonomy`，标签 Nova Accept，内置上表新 Android
  rootfs `4ca0d989…1023c`，经 `unzip` 核对），安装/启动/卸载命令在 `$SESSION/android-accept-install.txt`，
  `SESSION=$HOME/Library/Caches/nova-build/7cb31a9d7ee6/cjk-worker-20261104`。
  补测步骤：用户先重连无线调试、点亮并解锁、允许 USB 安装 → `adb devices -l` 确认同一台（明确 `-s`）→
  只安装一次 → 每次 input 前确认前台是验收包 → 用例 A 至少 3 次、同判据 → 只卸载该验收包。
- **iPhone 真机：BLOCKED，未安装/未触碰**（免费签名安装名额已满，用户稍后自己腾名额）。

### 本轮清理与凭据安全

- 清理：先卸载模拟器中的验收包、shutdown、delete **仅 UUID `40C58B42-D4FA-4B3C-8AD9-CDA975409ED8`**，
  `simctl list` 确认已不存在；其它会话的模拟器和进程未触碰。小米未安装任何包，无需卸载。
- 凭据：模型 key 只用 `.env` 的 `DASHSCOPE_API_KEY`，构建进程环境由白名单构造（不 `source` 整个 `.env`），
  只通过 dart-define 进入验收构建，构建日志写入前按值脱敏。按 key 值及其 base64（含 `NOVA_E2E_KEY=` 前缀的 base64）
  扫描：本轮证据目录、`clients/flutter/docs`/`tool` 工作树、从 `29433ad6~1` 到 HEAD 的全部提交 diff（787 KB）、会话
  目录构建/bake 日志均 **0 命中**；`.env` 中其它 7 个 KEY/TOKEN/SECRET 类变量值在该提交 diff 中也 0 命中。
  含 key 的 APK/已签构建产物仅留在权限 700 的会话目录。工作树里仍有 ignored 的生成文件
  `test/support/device_e2e_materials.g.dart`（合成工作簿+公开论文的 base64，小米补测构建需要），不含 key，未提交。

## 首轮与第一次提示修复：失败原样保留

- [Android首轮](evidence/device-e2e/android-before-fix.json)：A69.325s，PDF数字、中文及
  NovaDocumentSansSC嵌入均正确（[PDF](evidence/device-e2e/android-before-fix-summary.pdf)），
  当轮未验证UI导出，不能冒充整个A通过。B30.020s，唯一shell0.446s/exit0；
  [脚本](evidence/device-e2e/android-before-fix-extract.py)只读前3页再硬截4000字符，
  实到模型4037字符（只有p1及p2部分）。最终无页码引用，FAIL。
  数字75%/316×等可在p1核对；“首次系统化”比实际读到的摘要贡献更强，缺依据。
- 首次启动约5秒后Activity销毁，FlutterEngine.destroy报ConcurrentModificationException，
  未执行shell；第二次启动取得首轮完整结果。未修FlutterEngine/其它无关代码。
- `af39be3c` 第一版仅改既有文档提示：分页分块、追踪被截内容、(p.N)与未读披露。
  [Android第一次修复](evidence/device-e2e/android-first-fix-report.json)：A68.898s，
  新生成sales_by_city_report.pdf表格已经有方块，报告同时列有旧首轮正确PDF，
  **不能把旧PDF当新PDF通过证据**。B72.428s/B2 33.303s均FAIL。
  B有“第4–5页/第6–7页”范围引用，但还出现无依据的P95≤180ms、90%+请求、
  端到端稳定<200ms等断言；原文p6明确LLM生成500–8000ms。
  早期进度按简单正则称“零页码”不准确，本报告以完整回答/原文核查为准。
- [iOS模拟器第一次修复](evidence/device-e2e/ios-simulator-first-fix-report.json)：
  A4.704s失败，模型试图pip安装，被fixture在native execute之前拦截；当时throw
  被ToolRunner记成outcome_unknown（0.002s）。B156.922s/B2 21.834s无最终页码引用，FAIL。
- 最后一版 `347c52c4` 仍只改文档提示：明确最终覆盖/分节/逐项引用格式，禁止静默截前缀，
  建议保存多行Python脚本避免分号后for语法错误。用户指令、模型、四工具未改变。
  fixture将确定“从未执行”的安装拒绝改成completed/exit126，保留尝试且允许模型恢复。
  最终结果如上；**没有第三次提示调整，没有为过关修改输出或标准**。

## UI 冒烟边界

最初有其它Nova前台活动，一次试探tap后发现非验收聊天，立即停止，没有发送消息或
改系统设置。协调取得用户明确的独占窗口后才恢复；此后每次input先查前台component，
仅操作验收包或它在同一task38128直接启动的系统picker/chooser。

Android已验证：
1. 产品LocalChatPanel回形针“添加文件（最多25MiB）”存在，点击拉起系统
   `OPEN_DOCUMENT` / `com.google.android.documentsui...PickActivity`。
2. 自己push的`/sdcard/Download/nova-device-e2e-sales-oct.xlsx`，在DocumentsUI按精确名称
   搜索并选择，回到验收包显示附件chip；未读取选择器里其它文件、未发送额外模型请求。
   [附件chip截图](evidence/device-e2e/android-import-chip.png)、
   [picker证据](evidence/device-e2e/android-picker.txt)。
3. 生成city_summary.pdf在聊天显示真实文件chip，点击拉起
   `android/com.android.internal.app.MiuiChooserActivity`，持有
   `content://com.nova.nova_mobile.autonomy.documents/.../city_summary.pdf`的读权限。
   [文件chip截图](evidence/device-e2e/android-file-chip.png)、
   [chooser证据](evidence/device-e2e/android-chooser.txt)。
   **没有选择外部viewer/分享联系人，不声称ACTION_VIEW已被外部应用处理**。

真实导入/文件chip/系统chooser链路通过，不消除PDF乱码FAIL。
iOS真机未装；模拟器只验证到fixture真实模型/工具、PDF读回和聊天组件渲染，
**没有点击文件chip，也未验证系统分享表单**。

## 包安装联网、凭据安全与清理

- **没有设备联网安装包或字体**。完整模型shell及file_write脚本审查未见执行的
  pip/apk/下载路径；两次iOS `pip install ...`尝试均在native调用前被拦截，见
  [package-attempts.json](evidence/device-e2e/package-attempts.json)。最后一次exit126后
  模型改用预装库。此为调用/脚本审计证据，**没有做OS级全网抓包**；真实模型HTTPS
  本来需要网络，不能称整台设备离线。主机构建pub/Gradle/Docker拉取不等于手机装包；
  rootfs baker的包安装为锁驱动`--network=none`离线安装。
- **安全偏差如实记录**：早期Xcode会回显继承环境，过滤器仅覆盖实际使用key，导致其它
  未使用的.env凭据短暂写入会话私有目录的6份本地构建日志。未打印到工具输出、
  报告或提交。发现后立即按所有凭据变量原地脱敏，并剔除后续构建子进程环境中的
  KEY/TOKEN/SECRET/PASSWORD变量，实际key仅dart-define传递。最终日志与所有新增
  Git历史blob按授权凭据原值及相关编码检查；报告只记录审计结论，不记录值。
  不能把“最后已脱敏”改写成“从未写入本地日志”。受此早期日志偏差影响的未用变量为
  ARK_API_KEY、DEEPSEEK_API_KEY、DOUBAO_BIGMODEL_API_KEY、GEMINI_API_KEY、
  OPENROUTER_API_KEY、TAVILY_API_KEY；实际使用的DASHSCOPE_API_KEY始终有流过滤。
  因曾写盘，建议用户按自己的风险判断轮换上述六项；本任务未擅自轮换。未复制/修改源.env。
- 清理已执行：`adb uninstall com.nova.nova_mobile.autonomy`成功，之后pm查询为空；
  只删除自己放的`/sdcard/Download/nova-device-e2e-sales-oct.xlsx`与
  `/data/local/tmp/nova-device-e2e-window.xml`，确认均不存在。
- iPhone未成功安装任何验收包，最终devicectl确认thinkingAcceptance不存在，
  日常Nova/内网版/AvatarForcingLab均仍在；无验收包可卸载，未动用户数据。
- 先卸载本会话模拟器验收包，再shutdown/delete **仅UUID FFE715B8-A30B-4637-A2C3-5E47F56E9BC4**，
  确认simctl列表无该UUID；未操作其它模拟器。含key的构建工件仍在权限700的主机会话
  输出中（用户要求保留真机补测工件），不是可发布包。工作区内含define的ignored
  iOS生成配置已移除；仅保留受限构建输出。

## 验证命令与未解决问题

- `flutter analyze --no-pub`：最终No issues found（2.1s）。
- `flutter test --no-pub test/agent_host_capabilities_test.dart test/agent_core_test.dart
  test/local_chat_documents_test.dart test/document_workspace_test.dart`：最终**20 passed**。
  中间一次本轮新增提示断言仍匹配旧措辞而失败，单独更新断言后重跑通过；未动基线失败。
- `PYTHONPYCACHEPREFIX="$SESSION/pycache" python3 -m py_compile tool/device_e2e_materials.py`：通过。
- Android最终Gradle `-PnovaAutonomyTest=true -Ptarget=<fixture> -Ptarget-platform=android-arm64
  -Pdart-defines=<不记录值> assembleDebug`：BUILD SUCCESSFUL（14s）。
  manifest标签覆盖仅通过会话Gradle init script/source manifest副本。
- iOS最终iphoneos及iphonesimulator xcodebuild：BUILD SUCCEEDED；DerivedData/SDK缓存隔离。
  iphoneos使用team9A32786S6Z、cached Automatic、无扩展，最后只构建未重试安装。
- `git diff --check`通过；结束未留staged文件，无push。

仍需单独处理：真实iPhone安装配额后的补测；模型遵守字体/TableStyle与阅读覆盖要求的
可靠性；伪造引文与未依据原页的推论；iOS语言保持与系统分享手测。
两次提示改动改善引用格式，但**不能作为可靠文档生成/无幻觉的产品保证**。
