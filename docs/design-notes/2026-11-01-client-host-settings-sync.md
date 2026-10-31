# Client 与 Host 设置同步

用户已授权在独立 worktree 自主实现，并明确要求手机 Client 通过 Client↔Host 通道读取、写入并同步 Host 设置。实现复用两轮 Claude CLI / claude-sonnet-5-5 讨论中可由现有源码验证的建议；外部建议不是验收证据。

## 权威与范围

- Space 模式下，Host 的模型路由只有一个持久化存储；PC 与手机不能各保存一份不同的选择。
- 复用 `runtime/config/model-routes.ts` 的严格 lane/provider/model schema、元数据与模型目录。首个完整切片涵盖既有六条模型 lane、凭据引用，以及通用模型表单；不新增任意 env 或文件写入接口。
- Client 读取 `host_settings.models` 脱敏投影，以既有 `settings.patch / models.configure` 写入，以既有 `secret.put` 单独写入密钥。两者使用现有持久化 intent、依赖、回执、版本冲突和加密通道。
- 手机不读取 Host 密钥，不启动本机 Agent。外观与手机权限仍由设备本地处理。
- 远程自定义 endpoint 和 OAuth 不伪装为已支持；模型服务选项由 Host 的实际白名单、凭据状态和已配置 endpoint 决定。本地适配器保留现有自定义 endpoint、多凭据、模型列表和 OAuth。

## 存储与启动

新增 `HostModelRoutesStore`，路径固定为 `configPath + '.models.json'`，包含版本、完整路由和有界已应用 op_id。修改是稀疏 lane 补丁，null 删除该 lane 并恢复默认；先严格校验，再检查 op_id 与 expected_version，在同一次原子写中提交结果。

PC 在首次启动该 Space、runtime 启动前，用已有模型路由进行一次不覆盖目标文件的播种。Space 模式 main 不再派生注入 `MODEL_ROUTES`；因此保留下来的显式 `MODEL_ROUTES` 确实属于运营者，优先并使路由只读。headless 保留同样语义。

启动 overlay 从共享存储生成 `MODEL_ROUTES`；保存先持久化，重启后生效。新路由必须已有可用凭据；手机新输入的密钥先写入，再提交依赖它的路由。PC 新密钥需先保存并重启载入，再选择模型。投影返回 version、applied_version、source、locked、routes、provider 目录和 lane 白名单。运行中变化使用无秘密的结构化通知提醒 main 刷新设置和重启状态。

PC 的模型设置保存经既有本地专用 `space.models.configure` 控制命令提交同一个 runtime store，状态读 `space.models.status` 或已校验的原子文件。main 不在 runtime 运行中直接写这个文件。手机的写入仍要求 Space 所有者；PC 控制命令仍只接受 `desktop:local`。

## Flutter 复用

共用模型编辑表单、设置分组与外壳；模型服务入口按本机与 Host 实际能力展示。表单只依赖一个窄的模型配置 backend，读取无秘密的视图、提交选择与可选新密钥。本地 backend 包装 `ModelSettings`，远程 backend 包装 `SpaceClientState` 和现有同步函数。

普通排队操作在后台执行；失败和冲突保留用户可读的处理入口，不显示协议名或原始错误。刷新按钮在标题栏左侧，右侧用紧凑的设置和 Space 图标；手机宽度下验证标题居中。

## 验证重点

未知 lane/provider/字段拒绝；非所有者拒绝；运营者配置只读；PC 与手机使用同一 store；重启前后 applied_version 正确；落盘后回执前崩溃不二次应用；并发版本冲突；密钥不进入视图/日志；依赖拒绝不发送后续模型修改；旧 Client 忽略新增投影。

本地表单既有自定义服务、凭据与模型列表行为保留；远程 backend 零本机 Keychain/native 模型写入；共享表单对两种 backend 均执行有意义测试。iOS 真机操作受设备现场状态限制，用户休息后不再发出需要现场响应的请求。


## 完成与验收记录

代码位于独立分支 `feat/client-host-settings-sync-01a19282`，基于 Tailscale 扫码修复 `9c74a2b4`。工作区原有 `.tmp/` 和用户原始数据未改动。没有合并或推送。构建产物和编译缓存均放在本会话内部磁盘隔离目录。

- 两轮 Claude CLI 使用用户指定的 `claude-sonnet-5-5`，仅发送相关源码与架构问题；未发送真实凭据、手机数据或现场日志。
- 独立复查修复：空模型文件必须保留并拒绝覆盖；重复本地请求保留版本回执；失败依赖向后传播并在旧队列恢复时可见；所有远程模型 lane 可恢复默认；手动采集入口不冒充系统日历授权；新路由必须具备可用凭据。
- 桌面 Node 全套：1796 项，1783 通过，13 项既有跳过，0 失败。随后补充的模型状态边界测试 8 项全部通过。React 设置及 Space/提示相关 43 项通过。
- Runtime 设置、桌面控制与 Host 管理针对性套件 51 项通过；并入桌面模型测试的日志共 58 项通过。Runtime 编译和 renderer TypeScript 检查通过。
- Flutter 设置、原有本机设置、导航、Host 管理、头像和队列回归 112 项通过；最后文案修改涉及的 34 项复跑通过。修改范围 Dart analyze 无问题。
- 真实 Dart→Node Relay→实际 SpaceHost 互通：3 项通过，包括原有大快照与断线恢复、新配置加密写入、落盘前后依赖保持、Host 配置回读、电脑 CAS 修改自动同步、旧手机编辑冲突、Host 重启后保留路由和密钥状态。临时测试未调用任何模型。
- iOS Release build 25 使用真实原生依赖构建并签名，通过既有无线连接原位安装到原 app，并回读 `bundleVersion=25`，未清空数据。设备处于锁屏状态，启动请求明确返回 Locked，未继续要求解锁。隔离测试 Host 升级后确认所有者仍在、原测试待办仍为已完成。

复现方式（先将 runtime/dist 与 relay/dist 指向各自会话的隔离输出，再顺序编译，勿清理共享目录）：

```sh
node_modules/.bin/tsc -p runtime/tsconfig.json
node --test runtime/dist/test/space-host-model-settings.test.js runtime/dist/test/space-host-admin.test.js runtime/dist/test/desktop-control.test.js
node --test clients/desktop/test/main-space-models.test.mjs
```

在 `clients/flutter` 运行：

```sh
flutter test --no-pub test/model_settings_backend_test.dart test/model_settings_editor_test.dart test/remote_model_settings_backend_test.dart test/space_client_ui_test.dart test/space_client_test.dart test/space_host_panel_test.dart
NOVA_RUNTIME_BUILD_ROOT="$PWD/../../runtime/dist/src" NOVA_RELAY_BUILD_ROOT="$PWD/../../relay/dist/src" flutter test --no-pub test/model_settings_relay_live_test.dart test/space_relay_live_test.dart
```

## 保留的能力差异与证据边界

手机头像与系统权限保持设备本地。模型选择、密钥、助手设定与飞书授权走 Host。Client 当前没有本机语音引擎、定时执行器和完整工具过程投影，因此没有复制会失效的本机语音配置、定时任务或过程显示开关；语言界面仍沿用当前 Client 的中文实现。远程任意 endpoint、OAuth、多账号密钥选择尚未扩展协议。

PC 模型路由单独保存，避免与全局设置事务产生半提交；已有密钥不回显。Host 模型选择与密钥仍需重启生效，环境配置优先且只读。PC 新增全局密钥须先保存并重启载入，再保存使用该凭据的路由。

build 25 的页面尚未经用户现场人工操作验收；此前 build 24 的 Space 切换和手机待办完成已由用户验证，不能替代新版页面验收。没有证明锁屏推送、Android/Windows 真机、真实模型调用或语音根因；未删除历史重复 Space。
