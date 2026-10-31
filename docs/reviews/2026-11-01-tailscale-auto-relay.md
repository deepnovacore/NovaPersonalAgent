# Tailscale 自动 Relay 与手机绑定：Review 和验收

基线：`b13779d4`，续接 `fix-1031-review-and-tailscale-handoff.md` 中的四个提交。本次不发布、不合并到公共远端，不迁移原独立模式数据。

## Review 结论

此次改动让桌面创建 Space 时自动托管 relay、生成凭据并使用 Tailscale HTTPS。手机沿用原有一次性邀请、指纹确认、密钥投递和加密同步协议。

1. **已修：语音遥测仍可能带出凭据。** 原正则允许 32 位纯字母或 `PrivateCredential` 形式的未知服务商错误码。测试复现后改为明确允许的诊断码集合，其他内容不记录。语音连接失败可见化不等于原来的语音故障已经修复。
2. **已修：创建表单的 Strict Mode 生命周期。** 挂载标记在 effect 清理后没有重新启用，异步创建结果可能被丢弃。恢复挂载标记并增加回归测试。
3. **已修：扫码重试生成重复 Client Space。** 网络响应丢失后，再扫码会创建新身份。现在按 relay origin、Space 和 Host 复用已有记录及设备身份；已获准设备直接恢复登录。先读取原内容密钥再登录，防止重扫已轮换密钥的 Space 时清空密钥。
4. **已修：重复加载与快速连点。** catalog 的并发或重复 `open()` 不再重复追加记录；创建表单拒绝正在处理时再次提交。
5. **已修：Client 缺少快速 Space 切换。** 连接中的页面、连接失败页面和四个主页面都可以切换 Space。保留原设置页入口和原有缓存。
6. **已修：iOS 原生构建仍强制使用外接盘。** 构建和打包改为要求明确指定内置盘隔离目录，保留 CI 隔离约束；未移除或替换 iSH/Alpine 原生依赖。

完成后进行了一轮独立只读复核，未发现此次范围内的具体阻断问题。后续设置一致性和标题栏交互调整放在另一 worktree 中，不计入本次结论。

## 自动 Relay 的边界

- 只有设置窗口主帧可以请求 `{mode:"tailscale"}`；并发锁覆盖自动配置阶段。bootstrap token 不经 IPC 返回、不写盘、不进日志。
- `RelayServer` 在桌面主进程运行，只监听回环地址，数据固定在应用数据目录 `space/relay/`。每次启动重新生成 bootstrap token；会员关系和密文邮箱保留在原数据库。
- Tailscale 必须已连接，节点具有自己的 MagicDNS 名称与 HTTPS 证书能力。首次从 8443、9443、10443 选择未被使用的端口，随后固定 origin。
- 不覆盖已有 Serve 配置，不使用 Funnel。固定端口被占用或节点域名改变时保留数据并拒绝换身份、换地址。
- 使用本次持有的前台 Serve 会话。桌面退出先关闭会话再关闭 relay；父进程管道丢失也会结束 CLI，避免崩溃后继续转发已失效的本地端口。
- 启动时恢复原 relay，Serve 异常退出时自动重试。创建失败仍沿用既有 init/resume 流程。首次证书签发可能让请求超时，重试不会换身份。
- 手机扫码后仍需核对指纹并由 Host 确认；随后才投递空间密钥。“免密”省去手填 relay 与 token。

## 验证结果

| 层级 | 结果 |
| --- | --- |
| 桌面 Node 全量 | 1787 项，1774 通过，13 跳过，0 失败 |
| 桌面 React | 16 个测试文件，0 失败 |
| runtime 定向测试 | 122 项通过，含语音失败、遥测、桌面控制和飞书状态 |
| Flutter 定向测试 | 33 项通过，含扫码重试、轮换密钥保留、catalog、快速连点、切换 UI 与真实 Dart/Node relay |
| iOS 输出目录契约 | 2 项通过 |
| 编译与分析 | runtime、relay、renderer TypeScript 通过；相关 Flutter 文件分析通过 |
| 真实协议联调 | 注册结果丢失后的 resume、签名配对、加密消息、relay 重启后补拉通过；Dart 客户端恢复超过 2MiB 的积压通过 |
| Electron / ASAR | Electron 43 从实际 ASAR 加载创建处理器、runtime/space-host 和 relay/server，真实 Tailscale HTTPS 创建与重启恢复通过 |
| iOS 构建 | 内置盘隔离目录构建真实固定版本 iSH/Alpine，Xcode Release 构建成功 |
| iPhone 原位更新 | 同 Bundle ID 无线安装 build 24；安装后读回版本确认成功 |
| iPhone 前台验收 | 用户核对指纹并批准绑定，确认 Host 在线和测试待办可见；新版切换正常；手机完成待办后 Host 落盘为 done、version 2，手机收到后续快照并 ACK |

## 复现命令

先在独立 worktree 编译 runtime/relay，保持各聊天输出隔离。不要运行会清理其他聊天 `runtime/dist` 的命令。

```sh
node --test clients/desktop/test/*.test.mjs
node clients/desktop/scripts/test-react.mjs
node --test runtime/dist/test/realtime-qwen.test.js runtime/dist/test/realtime-qwen-transport.test.js runtime/dist/test/desktop-control.test.js runtime/dist/test/feishu-connector.test.js
node --test clients/flutter/tool/ios-build-output.test.mjs
cd clients/flutter
NOVA_RELAY_BUILD_ROOT=/absolute/isolated/relay/dist/src flutter test --no-pub test/space_pairing_test.dart test/space_root_test.dart test/space_client_ui_test.dart test/space_client_test.dart test/space_storage_test.dart test/space_relay_live_test.dart
```

真机和 ASAR 联调脚本、签名产物及原始日志仅留在本次忽略的构建目录；其中含测试身份、一次性邀请和设备信息，不入库。源码中的集成测试不依赖这些私有记录。

## 限制

- 未宣称原语音故障已修复，也未完成 Windows、Android、APNs 或锁屏投递验收。
- 本机开发描述文件没有 APNs 能力，build 24 用于前台配对和同步验收；不是正式推送或发布验收。
- 已存在的重复本地 Space 条目和缓存没有自动删除。修复阻止之后的重试继续新增。
- Tailscale 节点改名和固定端口冲突不会自动迁移已绑定的手机。
- 此次未全量重跑 runtime；交接中记载的原有五个数据库失败不能据本次定向测试宣称消失。
