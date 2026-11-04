# 手机通用文件与 Linux 工具

Flutter 手机端继续使用 Nova 自己的 `AgentCoreHost` 模型/工具循环。此次替换的是工具层：移除模型可见的 `artifact_*`，使用 `file_read`、`file_write`、`file_edit`、`shell_execute`。iOS 的 Linux 内核来自 iSH ARM64，Android 使用 PRoot；两端使用 Alpine 用户空间，具体版本与校验值固定在 `tool/linux/` 的构建脚本中。

## 工具契约

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `file_read` | `path`, `offset?`, `limit?` | 读取 UTF-8 文件或列目录。偏移从 1 开始，默认最多 2000 行/项，文本最多返回 64 KiB；返回截断标记，二进制仅返回元数据。 |
| `file_write` | `path`, `content` | 创建父目录，原子创建/替换完整 UTF-8 文本，单次最多 1 MiB。返回文件路径和 `nova-file` 链接。 |
| `file_edit` | `path`, `old_string`, `new_string`, `replace_all?` | 精确替换；默认必须恰好匹配一次，多匹配或未匹配均不写入。源文件与结果均不超过 1 MiB。 |
| `shell_execute` | `command`, `cwd?`, `timeout?` | 在手机 Linux 中执行 `/bin/sh -c`。默认目录 `/workspace`，超时默认 60 秒、允许 1–3600 秒；返回 stdout、stderr、exit_code、状态及截断信息。 |

文件工具通过 Dart FFI 调用原生 POSIX 文件 I/O，访问应用支持目录下的 `nova-workspace`，Linux 将同一目录挂载为 `/workspace`。相对文件路径从此目录开始，工作目录也限制在此目录下。文件工具逐层打开目录描述符，并使用 `openat` / `O_NOFOLLOW` 访问文件，拒绝越界路径和符号链接；Linux 系统文件及软件包通过 shell 操作。iOS 工作区使用真实文件系统挂载，不直接改写 iSH fakefs 的 payload，因此不会绕过其元数据库。

工作区是设备级持久目录，任务之间共享；需要隔离内容时，在 `/workspace` 下使用不同子目录。Alpine 中安装的软件包也持久保留。新镜像预装 Python 3.12 与文档基础库；旧安装保留原 rootfs，不自动迁移。`bash`、`nodejs` 等额外工具仍可通过 `apk add` 按需安装，需要网络，失败按实际退出码反馈。没有将模型命令转发给电脑执行。

Shell 返回 `completed` 仅表示进程结束；`exit_code != 0` 仍是失败的命令，模型可根据 stderr 修正。取消与超时保留已收集输出；执行后失去可靠回执时返回 `outcome_unknown`，不得自动重放可能已有副作用的命令。每次执行有独立 ID，取消只针对该次命令。系统后台时限仍然适用，不保证应用离开前台后持续运行一小时。

工具结果属于不可信数据。Linux 使用应用本身的 OS 权限，PRoot 是兼容层，不是独立的安全沙箱；不要将恶意代码视为经过隔离的可信输入。

## HTML 与浏览器检查

先通过文件工具保存页面与检查脚本，再调用：

```sh
nova-browser inspect --path /workspace/index.html --script /workspace/check.js
```

`check.js` 是浏览器 JavaScript **函数体**，例如：

```js
document.querySelector('button').click();
return { text: document.querySelector('#result').textContent };
```

此命令访问当前 shell 执行期间的认证回环端点，读取保存的文件并调用系统 WebView。页面最多 256 KiB，检查脚本最多 8000 字节，JSON 结果最多 32 KiB。端点只接受工作区路径，单次执行最多接受 32 个检查请求，并拒绝重叠检查。它不会执行宿主 shell，也不会向 Linux 注入模型 API 凭据。

浏览器检查需要可用的应用界面/WebView；无界面的后台唤醒不保证可以运行，失败会返回实际错误。现有预览引擎加载**单文件 HTML**：JS/CSS 应内联，不加载相对路径资源或网络资源。多文件项目可在 Linux 中构建/打包成单文件再预览；`nova-browser` 不等同于 Node.js，也不是任意网站的浏览器自动化接口。聊天中的 `nova-file:///workspace/index.html` 链接打开同一保存文件的交互预览。

## 迁移、语音与计划任务

首次打开工作区时，旧 `local-artifacts-v1.json` 的 HTML 迁移到 `/workspace/artifacts/<id>/index.html`。已有目标文件不会被覆盖；成功迁移的 ID 记录在工作区外的迁移检查点中，重复启动保留用户后续修改、移动和删除。旧 JSON 留作恢复副本，不再接收写入；旧 `nova-artifact://<id>` 链接继续映射到迁移文件。没有第二套模型可调用的 artifact 工具。

文本对话与语音慢脑使用同一工具注册实现。语音快脑仍只暴露 `delegate_task` / `cancel_delegate`，工具结果通过现有委派回传和播报时机规则处理。计划任务新增显式的工作区授权，默认关闭；已有任务不会自动获得文件或 shell 权限。

## 构建与验证

先准备并打包 Linux 运行时，再构建 Flutter 应用。所有构建输出、临时目录和编译器缓存放在内置盘，按规范化 worktree 路径与会话 ID 隔离；不依赖外置盘。缺少运行时会使构建失败，不会静默生成没有 shell 的包。

- Android 构建与源码许可证：[Android runtime](../tool/linux/android/README.md)、[第三方来源](../tool/linux/android/THIRD_PARTY.md)。
- iOS 构建：`python3 tool/linux/ios/build_runtime.py --output-root "$NOVA_SESSION_ROOT/ios" --sdk iphoneos`，随后给 Xcode 构建传入 `NOVA_LINUX_ROOT="$NOVA_SESSION_ROOT/ios"`。模拟器需要使用 `--sdk iphonesimulator` 单独构建 ARM64 库。
- Dart 回归：`flutter analyze --no-pub` 与 `flutter test --no-pub`。Hub 集成测试还要求此 worktree 的 `runtime/dist` 已在独立输出目录构建。
- 原生验收及脚本位于 `android/app/src/androidTest/`、`ios/RunnerTests/` 和 `tool/linux/`。
- `test/support/workspace_device_acceptance.dart` 是独立验收入口，实际调用工具注册、原生 Linux 与 WebView，检查中文文件互通、精确编辑、浏览器 DOM、退出码、超时、取消，以及使用预装 Python/字体运行离线文档 smoke（禁 Python socket 连接，无 APK/pip/字体下载）。旧联网安装测量须显式 `--dart-define=NOVA_ACCEPTANCE_ON_DEMAND=true`。输出 `WORKSPACE_ACCEPTANCE_JSON` 并保存 `acceptance-report.json`；它不请求模型服务或麦克风。网络较慢的地区可通过测试构建参数 `--dart-define=NOVA_ACCEPTANCE_APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine` 临时指定公开镜像；仍校验 Alpine 签名，不修改已安装环境的仓库配置。

编译成功、主机上的 iSH harness 和手机应用验收分别提供不同层次的证据；不能用其中一项代替 iOS/Android 应用实机验收。

2026-10-19 验证记录：Flutter 分析无问题，全量回归 842 项通过、4 项跳过；Android 7 项 JVM 与 5 项原生测试通过。ARM64 Android 模拟器与 iPhone 真机的 6 项端到端工具验收均全部通过：文件互通、WebView DOM、退出码、超时、取消，以及通过签名 APK 安装 Python 后执行脚本并输出 `45`。包下载使用上述仅验收生效的镜像参数。iPhone 首次运行受应用联网权限限制，诊断记录到 `wifiDenied`；允许联网后原生 HTTPS 返回 200，完整工具验收通过。诊断及保持亮屏代码仅在验收构建中启用，生产包不启用。

## 独立模式文档工作流

仅独立模式支持附件；不引入按格式工具，也不改变 Host 配对附件协议。
聊天输入框的回形针导入 PDF、XLSX、CSV、TXT、MD、JSON，每个最多
25 MiB（26,214,400 字节），每条消息最多四个。拒绝不安全文件名、路径分隔符、
控制字符、源文件/祖先符号链接和过大文件；支持的安全 Unicode 文件名保留原样。
文件复制为 `/workspace/inbox/<随机 id>/<name>`，原文件后续修改不会影响副本。
输入框上方 chip 可移除；移除只从草稿解绑，不删除已导入副本。发送时消息包含
工作区路径，附件内容是不可信数据而非指令。导入副本持久保留，需要时可自行清理。

推荐流程：

1. 用 `shell_execute` 检查 `python3`、库导入和字体是否存在。**新镜像预装**
   Python 3.12.16、`openpyxl==3.1.5 pypdf==6.1.1 reportlab==4.4.4` 及其固定依赖，
   不需在手机上 pip/apk 下载。标记 `/usr/share/nova/document-base.json` 在工作区外。
   已有安装升级后不替换旧 rootfs；没有标记/库时如实告知用户，仍可经授权联网安装
   `python3 py3-pip` 并在 venv 安装上述版本，不关闭 TLS/签名验证。
   旧用户不会自动获得离线能力；不要为升级删除用户数据或擅自重装应用。
2. XLSX 先看 sheet 名和尺寸，`load_workbook(path, read_only=True, data_only=True)`
   分批迭代行。`data_only` 读取已有公式缓存，不计算公式，缓存缺失时要说明。
   PDF 用 `PdfReader` 先查页数，按页提取文本；保持页码作为解释依据。
3. 将脚本保存后执行，只打印统计摘要、少量样例和输出路径。不要把整本工作簿或
   整篇论文塞入模型上下文；`file_read` 单次仍最多 64 KiB。重脚本显式指定更长
   timeout，并按页/块拆分；60 秒是默认值，不是文档任务的性能保证。
4. 输出写入 `/workspace/outputs`，返回例如
   `nova-file:///workspace/outputs/summary.pdf`。非 HTML 链接显示文件 chip：
   iOS 走系统分享表单（可选系统预览/存储/分享），Android chooser 提供
   ACTION_VIEW 与 ACTION_SEND；需要设备有对应文件查看器。
   保留原有 HTML 交互预览行为。URL 中空格、Unicode、百分号需正确编码。
5. 新烘焙镜像通过系统 `sitecustomize.py` 将 ReportLab 默认 Helvetica 四个名字
   自动指向 `/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf`；无需注册或下载字体，
   包括表格 `Helvetica-Bold` 与 canvas 默认字体。粗斜体别名仍是同一400常规字重。
   GB2312常用字/拉丁/标点子集不涵盖全部CJK或emoji；检查路径/字符覆盖，缺失如实告知，
   不要生成乱码PDF。生成后用pypdf读回检查中文，不仅核对数字。
   旧rootfs不自动迁移；`-I`/`PYTHONNOUSERSITE`仍加载系统钩子，`-S`禁用site则不加载。
   精确字体资产及批准哈希不变，见[资产记录](../../../docs/ASSET_PUBLICATION.md#approved-mobile-document-font-subset-2026-11-04)。
   fpdf2 不进入基础集（变量字体的 `fvar` 兼容性问题）。

非 HTML 导出仅允许 `/workspace/outputs/` 和 `/workspace/inbox/` 的普通文件，
最多 25 MiB。拒绝 `..`、编码路径穿越、远程 URL、符号链接和目录；逐层持有
`O_NOFOLLOW` 描述符读取快照，而非将活的 workspace 路径交给外部应用。
Android FileProvider **只**暴露专用缓存 `nova-documents/`，不暴露应用私有目录或
整个 workspace。系统分享本身会把所选快照交给用户选择的外部应用。

### 实测与限制

完整分平台安装、耗时、内存、失败项、复现命令及烘焙延期说明见
[2026-11-04 文档验收](mobile-document-validation.md)。两端 XLSX 1000 行求和、
20 页文本 PDF 读取、ReportLab 中文生成→pypdf 提取均通过；这不是大文件或
手机真机性能保证。openpyxl/pypdf 的 wheel 是纯 Python；ReportLab 本体为纯
Python wheel，但依赖 Pillow/charset-normalizer 的 musllinux aarch64 原生 wheel，
不能称整套纯 Python。

不支持扫描件/OCR、XLSX 写入/图表、Host 配对附件传输。iSH 无 JIT，大表、长文、
字体转换可能很慢；25 MiB 仅限制压缩文件/导出字节数，不限制 XLSX 解压后的
内存开销，不能把恶意文件视为安全沙箱输入。系统查看器和真实中文排版仍需手测。

**iOS App Review 2.5.2 对“应用内下载并执行代码”的影响未核实**。
实测可安装不等于符合审核规则；烘焙也不能自动消除审核风险。

### 烘焙实现与本轮验证

固定APK依赖闭包/wheel/font来源、Docker选型与规范化规则见
[构建锁说明](../tool/linux/documents/README.md)；本轮根文件系统哈希/体积与
设备验证边界见 [烘焙验收](baked-rootfs-validation.md)。原2026-11-04文档测量是
此前按需安装的历史记录，不能当成新镜像设备验收。

**CI已知风险**：现有iOS macOS Actions未配置Docker daemon/固定烘焙镜像，
当前会因缺daemon失败；未修改workflow、未声称CI通过。后续须单独提供可用
Docker runner或经锁文件生成并缓存的预构建rootfs工件。Apple审核2.5.2及
rootfs内可执行代码政策均仍未核实，预装不等于审核批准。
