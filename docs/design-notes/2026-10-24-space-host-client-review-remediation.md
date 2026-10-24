# PR #2 review 修复记录

用户对 `ff378da4` 的审阅指出发布包阻断及托管生命周期问题。本轮按复现、修复、独立复审推进；用户另明确允许必要时发布 relay，并选择一次性邀请准入。服务端目前选择随包携带 relay，确保离线安装及 runtime/relay 版本一致，没有执行 npm 发布。

| 意见 | 修复与验证 |
| --- | --- |
| #1 服务端包安装 404 | `bundleDependencies` 携带 relay 的 JS 白名单产物；旧完整包真实安装复现 E404，新包安装 671 个依赖并完成实际 Host→Relay 初始化、native/VAD/PTY、配对和退出验证。独立包装回归自行隔离编译，不依赖共享 dist。 |
| #2 历史控制回执阻止撤销 | 确认回执按 Space 限额；epoch 切换事务中回收旧回执并保留最新撤销响应。撤销不占用已满的确认配额，丢响应/重启仍能重放。 |
| #3 过期 mailbox 毒信封 | 新 mailbox 信封只能 `expiresAt:null`；旧库过期行可安全跳过并推进 ACK，撤销其发送设备后仍可恢复投递。 |
| #4 APK 共享准入密钥 | 删除客户端编译常量，运营端签发 15 分钟一次性邀请；兑换独立安装凭据，安装预算预留、注册幂等和 HTTP 限流。换 token/handle 不能消费其他安装的预算。 |
| #5 永久回执表封顶 | SQLite 按行事务替代全量 JSON 重写；handle 固定 30 天有效期，失效/撤销后级联回收其回执。旧 handle 永不复活，unknown 不重发；真实 SIGKILL 后 SQLite owner 锁由 OS 释放。Host 新回执也跟随 handle 安全回收。 |
| #6 代理后的源地址 | 显式可信代理 IP 白名单，HTTP/WS 从右向左解析可信链；默认忽略伪造转发头。部署必须配置可信代理且限制 origin 直连。 |
| #7 推送 TTL | 默认最长 24 小时并取业务期限较小值；持久 outbox 恢复时重查有效性，过期不推。APNs/FCM 折叠，MiPush 通知替换；不声称能撤回厂商已接受的推送。 |
| #8 macOS 临时目录 | 测试先 canonicalize tmpdir，不放宽生产私有路径约束；增加 macOS 与 symlink TMPDIR 整栈 CI。另修正测试对夜间静默窗口的隐式依赖，只调整 fixture。 |

## 独立复审及本地证据

独立复审又验证并推动修复 APNs sandbox/production 身份混淆、异步 enable 覆盖 disable、邀请响应丢失且票据过期后的恢复、共享安装凭据覆盖，以及降低 global 配置后的预算保证。GET installation 只接受已经生成的强安装凭据，不使过期邀请可再次兑换。

- 隔离 TypeScript 构建、runtime 全量 ESLint、整栈 **124/124**，真实 Client→Host→gateway HTTP 联验通过。
- Flutter 全量静态分析无问题，15 个相关文件 **62/62**，含真实 Dart→Gateway 邀请兑换、响应丢失、租期轮换；独立审查另亲跑 13/13。
- Gateway 的真实 SIGKILL/多 owner 互斥、跨 35 天回执 GC、安装预算隔离/重启、legacy JSON 迁移与 24 小时 TTL 均有回归。
- Android FCM/MiPush 5.1.2-C 的最终源码 APK 构建通过，各 **65/65**；未运行 App 或发送厂商推送。
- FCM APK SHA-256：`9ed73937f8657958b4446d9b083276711ecc6cac31749fa054188573625331b4`。
- MiPush APK SHA-256：`5b5c595c6341c817a13bbc806a5f7239393ba3a1cd44fd71dd23727c8c23e6c1`。

## 跨平台 CI 与退出回归

本轮移动/协议代码 `6cda332e` 的 [iOS PR run 40053693747](https://github.com/FishWoWater/NovaAudioAgent/actions/runs/40053693747) 已通过：Xcode 16.4、iPhoneOS 18.5、Runner/NSE arm64 及真实 iSH/Alpine、Flutter 资源断言全部成功。完整 CI 的 Ubuntu/macOS space-stack（含 symlink TMPDIR）也已通过。原 PR 的 Ubuntu 404 已本地复现及修复，完整安装包 CI 仍在运行；macOS runtime 阶段 job 超时尚待对照归因。诊断矩阵分别检出基线 `5652030e`、原审阅版本 `ff378da4`、修复 head；记录逐文件进度与失败，不放宽产品退出期限。

原始日志下载曾在云代理 CONNECT 到 GitHub 重定向的 Azure 存储时收到 403；未绕过代理。新增诊断 workflow 输出 GitHub annotations 并始终保存证据，使失败能被定位。

真机锁屏/隔夜送达、系统杀进程恢复、签名配置、最新小米 SDK 和外部密码学评审仍不在上述自动化证据中。此次未更改 Relay 其余历史容量上限，不将这份修复记录表述为无限托管容量承诺。升级 gateway 需停旧服务并备份，旧 JSON 保留，按 README 迁移；旧无期限 pending push 不会重新获得新的保留期，权威信箱数据不因此删除。


Windows 三方对照已确认本 PR 引入退出回归：基线 `5652030e` desktop 测试通过，原 PR `ff378da4` 与初轮修复 `6cda332e` 都超时停在 `will_quit`。读码与行为测试确定设置窗口 `closed` 回调仍调用已删除的 `cancelPhonePairing()`，导致 ReferenceError 并中断后续清理。实际执行该回调的 VM 回归先红，移除这唯一悬空调用后 185 项相关桌面测试通过。未增加 20 秒退出期限；修复后的 Windows 原生 CI 仍需运行确认。
