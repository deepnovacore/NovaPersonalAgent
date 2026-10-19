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

工作区是设备级持久目录，任务之间共享；需要隔离内容时，在 `/workspace` 下使用不同子目录。Alpine 中安装的软件包也持久保留。`bash`、`python3`、`nodejs` 是否可用取决于安装状态；可通过 `apk add` 安装，安装需要网络，失败按实际退出码反馈。没有将模型命令转发给电脑执行。

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

先准备并打包 Linux 运行时，再构建 Flutter 应用。所有构建输出、临时目录和编译器缓存必须位于已挂载的外置盘，按 worktree 路径与会话 ID 隔离；缺少运行时会使构建失败，不会静默生成没有 shell 的包。

- Android 构建与源码许可证：[Android runtime](../tool/linux/android/README.md)、[第三方来源](../tool/linux/android/THIRD_PARTY.md)。
- iOS 构建：`python3 tool/linux/ios/build_runtime.py --output-root "$NOVA_SESSION_ROOT/ios" --sdk iphoneos`，随后给 Xcode 构建传入 `NOVA_LINUX_ROOT="$NOVA_SESSION_ROOT/ios"`。模拟器需要使用 `--sdk iphonesimulator` 单独构建 ARM64 库。
- Dart 回归：`flutter analyze --no-pub` 与 `flutter test --no-pub`。Hub 集成测试还要求此 worktree 的 `runtime/dist` 已在独立输出目录构建。
- 原生验收及脚本位于 `android/app/src/androidTest/`、`ios/RunnerTests/` 和 `tool/linux/`。
- `test/support/workspace_device_acceptance.dart` 是独立验收入口，实际调用工具注册、原生 Linux 与 WebView，检查中文文件互通、精确编辑、浏览器 DOM、退出码、超时、取消，以及安装 Python 后运行保存的脚本。输出 `WORKSPACE_ACCEPTANCE_JSON` 并保存 `acceptance-report.json`；它不请求模型服务或麦克风。网络较慢的地区可通过测试构建参数 `--dart-define=NOVA_ACCEPTANCE_APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine` 临时指定公开镜像；仍校验 Alpine 签名，不修改已安装环境的仓库配置。

编译成功、主机上的 iSH harness 和手机应用验收分别提供不同层次的证据；不能用其中一项代替 iOS/Android 应用实机验收。

2026-10-19 验证记录：Flutter 分析无问题，全量回归 842 项通过、4 项跳过；Android 7 项 JVM 与 5 项原生测试通过。ARM64 Android 模拟器与 iPhone 真机的 6 项端到端工具验收均全部通过：文件互通、WebView DOM、退出码、超时、取消，以及通过签名 APK 安装 Python 后执行脚本并输出 `45`。包下载使用上述仅验收生效的镜像参数。iPhone 首次运行受应用联网权限限制，诊断记录到 `wifiDenied`；允许联网后原生 HTTPS 返回 200，完整工具验收通过。诊断及保持亮屏代码仅在验收构建中启用，生产包不启用。
