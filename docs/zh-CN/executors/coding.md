<a id="coding"></a>
<a id="从需求到结果"></a>
<a id="行为边界"></a>
# Coding：编码任务

编码功能把项目任务交给编码执行器。默认使用 Codex；新会话也可以通过 ACP 交给 OpenCode、CodeBuddy、Pi 或 DeepSeek Harness。使用前先在宿主计算机上安装所选执行器并登录。只需要安装你选中的执行器：只有选择 Codex 时才需要 Codex CLI。

## 从提出需求到返回结果

1. 说明目标，例如“给这个项目加一个搜索页面”。
2. Nova 收集缺失的信息，创建或切换项目需要你确认。
3. 执行器在获批的目录中工作，Nova 展示进度，需要额外权限时单独申请。
4. 结果返回当前对话，任务运行期间仍可补充约束、查询进度或取消。

## 边界

- 项目与会话身份由宿主认定，不依据执行器的文字描述推断。
- 取消不会删除项目文件或会话记录。
- 执行器不直接与你对话，也不替你批准操作。
- Codex 通过 `codex app-server` 运行，其他执行器通过 Agent Client Protocol（ACP）运行，见[选择执行器](#选择执行器)。
- 委派出去的编码工作会作为持久化的 Task 出现在 [Tasks](../tasks.md) 页面，带有验收标准和已核验的完成状态，可以随时接管或交还给 Nova。

搭建见[快速上手](../getting-started.md)，开发细节见[执行器契约](../archs/05-executors.md)。

## 进度与审批

较主动的提醒设置会在任务阶段变化时提供简短进展，不承诺固定的播报间隔。工作进行中，你仍可继续对话或补充约束。

审批通常只批准当前一次操作。执行器支持时，可以为当前权限请求申请会话范围的批准；具体范围由执行器决定，不等于永久授权。不支持的范围请求会保持待确认状态，不会被悄悄降为单次批准。项目确认不支持会话范围的授权。

## 选择执行器

在 设置 → 能力 → 编程 中选择新会话默认使用的执行器，也可以设置 `CODING_BACKEND`（`codex`、`opencode`、`codebuddy`、`pi` 或 `deepseek`）。修改后立即生效，无需重启语音。每个会话始终沿用创建时的执行器：改默认值不会迁移运行中的任务或已有会话，恢复会话时也总是回到原来的执行器。

先安装执行器，再用它自己的方式登录。Nova 会在 `PATH` 中查找 `opencode`、`codebuddy`、`pi-acp` 或 `dsh`；也可以在设置中填写绝对路径，或设置 `OPENCODE_ACP_BIN`、`CODEBUDDY_ACP_BIN`、`PI_ACP_BIN`、`DEEPSEEK_ACP_BIN`。登录状态和协议能力在任务开始时检查，而不是在启动时，所以某个执行器缺失不会影响语音和其他执行器。

### 依赖

编码模块是否可用取决于所选的执行器。选择 Codex 时，需要可用的 Codex CLI 并通过其沙箱检查，否则编码模块以关闭状态启动。选择 ACP 执行器时完全不需要 Codex CLI：编码模块直接使用该执行器启动，只有同时装了 Codex 时才会把它作为额外选项提供。在没有可用 Codex CLI 的电脑上把默认执行器切换为 Codex 会被拒绝，原来的默认执行器保持不变。所有执行器共用 Nova 管理的同一套工作区和项目目录，不需要为某个执行器单独配置。使用其他执行器时，`npa doctor` 会报告 Codex 缺失，但不会因此判定失败。

Nova 针对特定的执行器版本做过测试，其中一些需要打一个小的兼容补丁，避免失败或中断的回合被当作回答重放。这些脚本会核对确切版本，遇到其他版本会拒绝执行；重新安装或升级执行器会清除补丁，之后需要再运行一次：

| 执行器 | 测试过的版本 | 脚本（位于 `runtime/scripts/`） |
| --- | --- | --- |
| OpenCode | 1.19.0 | `install-opencode-recovery.mjs`（在 OpenCode 配置中安装恢复插件） |
| Pi | `pi-acp` 0.0.34，`@earendil-works/pi-coding-agent` 与 `pi-ai` 1.1.0 | `patch-pi-acp.mjs`、`patch-acp-recovery.mjs` |
| DeepSeek Harness | `@deepseek-ai/dsh-agent-loop` 0.2.0-rc.2 | `patch-acp-recovery.mjs` |
| CodeBuddy（Windows） | `@tencent-ai/codebuddy-code` 2.164.0 | `patch-codebuddy-recovery.mjs` |

各执行器目前的能力：

| | Codex | OpenCode | CodeBuddy | Pi | DeepSeek Harness |
| --- | --- | --- | --- | --- | --- |
| 接入方式 | app-server | ACP | ACP | ACP | ACP |
| 恢复会话 | 支持 | 执行器提供时支持 | 执行器提供时支持 | 执行器提供时支持 | 执行器提供时支持 |
| 执行中追加要求 | 支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| 取消 | 支持 | 支持 | 支持 | 支持 | 支持 |
| 询问模式下逐项审批 | 支持 | 仅限执行器主动请求的操作 | 仅限执行器主动请求的操作 | 不支持（询问模式下拒绝任务） | 仅限执行器主动请求的操作 |
| 询问模式沙箱（仅限工作区文件、不联网） | 支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| 你授权的 MCP 工具 | 支持 | 支持 | 支持 | 不支持（有授权工具时拒绝任务） | 支持 |

询问模式对 ACP 执行器的含义比对 Codex 窄。对 Codex，Nova 会把执行器限制在工作区内且不能联网，需要审批的命令或文件修改执行前也会先问你。对 ACP 执行器，Nova 只能回应执行器主动发来的权限请求，不会限制它的文件和网络访问；哪些操作需要询问，由执行器自己的权限设置决定。执行器自身配置里免询问放行的操作照常执行。执行器接受权限参数时，Nova 会传入当前模式：OpenCode 通过 `OPENCODE_PERMISSION`，CodeBuddy 通过 `--permission-mode default` 或 `--dangerously-skip-permissions`，DeepSeek Harness 通过 `DSH_PERMISSION_MODE`，询问模式下为 `read-only`，完全访问模式下为 `danger-full-access`。需要 Codex 那样的限制时请使用 Codex，或只在你愿意让它修改的工作区和账号里运行 ACP 执行器。

对 ACP 执行器，执行中追加要求会明确返回“不支持”；Nova 不会用“取消后重新开一个任务”来冒充。如果执行器找不到要恢复的会话，这个会话仍保留在列表里，修好登录或配置后可以再试。

MCP 工具和知识库默认不对 ACP 执行器开放，需要在能力配置文件里按执行器单独授权：MCP 服务用 `exposeTo.backends`，知识库用 `modules.knowledge.exposeToBackends`。原有的 `exposeTo.codex` 和 `exposeToCodex` 只对 Codex 生效。授权的工具会经由每个任务独立的本地代理提供给 ACP 执行器，代理只列出并执行你启用的那些工具。

