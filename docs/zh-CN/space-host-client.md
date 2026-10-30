# Space / Host / Client 开发与部署

一个 Space 有且只有一个固定 Host。桌面 Host 保存权威数据、调用模型和运行后台任务；手机 Client 保存展示缓存与待提交意图。独立手机 Space 使用本机运行时，不能原地变成 Client。新建或切换 Space 不迁移旧数据。Host 丢失后没有云端恢复或自动接管。

## 构建和本地验证

Node.js 至少 22.13。先安装仓库依赖，再选择已存在、当前任务独占的输出根目录：

```sh
npm run build:space -- --output-root /your/build-disk --run-id your-task
npm run test:space -- --output-root /your/build-disk --run-id your-task
```

脚本按 worktree 路径和 run-id 隔离编译结果，输出路径记作 `$SPACE_BUILD`。其 `node_modules/@nova-personal-agent/` 下包含 relay、push-gateway 和 runtime 的独立包。测试使用真实本地 HTTP/WebSocket 和固定模型输出，不调用外部模型或推送厂商。桌面普通构建也会先构建依赖的 relay 包。

## 运行顺序

1. 按 [relay 部署说明](../../relay/README.md) 启动自托管 relay。公网入口必须是 HTTPS；本机开发允许显式 loopback HTTP。创建 Space 的 bootstrap 凭据仅交给有创建权限的 Host 操作者，不发给手机。
2. 准备权限为 `0600`、至少 32 个随机字符的 bootstrap 凭据文件。用新目录创建 Host Space：

   ```sh
   node "$SPACE_BUILD/node_modules/@nova-personal-agent/runtime/dist/src/space-host/cli.js" init \
     --config /private/new-space/config.json \
     --data /private/new-space/personal.json \
     --relay https://your-relay.example \
     --bootstrap-file /private/relay-bootstrap
   ```

   配置中包含 Host 私钥和内容密钥，不能提交仓库或放到 relay。`--data` 必须是全新路径，已有数据不会被迁移或覆盖。配置和数据所在目录只能本用户访问：缺失的目录会以 `0700` 创建，已存在的目录需先 `chmod 700`，否则 `init` 报 `space_directory_must_be_private`。若网络在首次创建时中断，保留已写出的配置，使用 `resume --config /private/new-space/config.json --bootstrap-file /private/relay-bootstrap` 重试同一身份；不要删除配置重建身份。
3. 设置 `NOVA_SPACE_HOST_CONFIG=/private/new-space/config.json` 后启动桌面端。桌面的 Settings → Connections → Space 与手机可生成一次性二维码、核对手机完整指纹、确认绑定及撤销设备。
4. 手机选择“Client”，扫描二维码；在手机与桌面核对指纹后由桌面确认。Client 等待密钥投递后补拉展示数据。Host 离线时状态修改显示等待，聊天立即失败，不会等 Host 上线后悄悄发送。
5. 在手机创建其他 Space 可选独立模式或另一 Host 的 Client；每个 Space 的凭据、缓存、意图和工具执行记录相互隔离。桌面切到另一个 Host Space 需使用另一份独立配置启动。

## 无桌面 Host（Linux / macOS）

没有桌面界面的机器可以直接作为 Host：同一个服务进程运行 Space Host，配对在终端完成。

1. 构建（见上）并按 [relay 部署说明](../../relay/README.md) 启动 relay。
2. 用 `init` 创建 Host Space（命令见“运行顺序”第 2 步，`nova-space-host` 即 `cli.js`；安装服务端 npm 包后可直接使用 `nova-space-host` 命令）。
3. 在私有（`0600`）环境文件中设置：

   ```sh
   NOVA_SPACE_HOST_CONFIG=/private/new-space/config.json
   SERVER_PORT=19876
   SERVER_TOKEN_FILE=/private/nova/client-token
   # 以及模型凭据、流水线和绝对工作区路径
   ```

   `SERVER_MEDIA_MODE=relay` 是手机语音的音频中继，与 Space relay 无关，不需要为 Space 配置它。
4. 启动服务：`novapersonal-server --env-file /private/nova/server.env start`。服务运行期间，配置文件旁会出现 `config.json.admin.sock`（权限 `0600`，随服务退出删除）；能读取 Host 私有配置的同一系统用户即可使用它，没有额外口令。
5. 在第二个终端配对（SSH 需要 `ssh -t`）：

   ```sh
   nova-space-host pair --config /private/new-space/config.json
   # 等价：novapersonal-server space pair --config /private/new-space/config.json
   ```

   终端显示一次性二维码，在手机 Nova 选择“连接 Host”→“扫描 Host 邀请码”扫描。手机发起请求后，终端打印完整指纹，核对与手机显示一致后输入 `y` 确认。无 TTY 的自动化场景需传入 `--yes-fingerprint <指纹>`，指纹必须与请求完全一致。`--timeout-seconds N` 调整等待时长（默认 300），Ctrl+C 取消。
6. 管理设备：`nova-space-host devices --config ...` 列出已绑定设备，`nova-space-host revoke --config ... --device 设备ID` 撤销并轮换密钥，`nova-space-host status --config ...` 查看状态。服务未运行时这些命令报 `space_host_not_running`。

## 通知与手机工具

锁屏通知另需部署 [push gateway](../../push-gateway/README.md) 和厂商配置。Host 私有配置的 `push_gateway_url` 固定为所信任的 HTTPS gateway；手机首次启用通知时输入运营端签发的一次性邀请，兑换本安装独有的凭据，再直接向同一 gateway 登记令牌；运营端签名密钥不得编译进 App。手机只把随机句柄和受限凭据交给 Host，安装凭据不交给 Host。固定期限的句柄由 Client 在到期前轮换，详见 gateway 部署说明。App 内数据补拉不依赖推送成功。小米公信使用通用文案且受配额限制。

Client 的系统工具只执行 Host 明确下发的动作，并检查前台状态、系统权限、用户确认和持久化 action-id。当前包含日历读取、相机拍摄；提醒创建限 iOS，Android 返回明确不支持。Client 不运行本地模型或自主规划循环。

## 手机管理 Host

只有全新的、尚未绑定任何设备的 Host 才会把第一台经确认的手机设为所有者。已有成员却没有所有者的 Host——所有者被撤销而其他设备仍在，或带着设备升级的旧 Host——不会把之后的手机提升为所有者，因为所有者能控制模型密钥和飞书登录：此时管理类意图返回 `owner_unassigned`，任何设备都无法修改凭据。需要找回管理权限时，用 `nova-space-host devices --config ...` 列出已绑定设备，再用 `nova-space-host revoke --config ... --device 设备ID` 逐个撤销；成员清零后 Host 恢复全新状态，下一台经确认的手机成为所有者。只有所有者设备能在手机“设置 → Host 设置”中修改助手名称、称呼、角色设定、主动发现和资讯主题，管理 Host 模型密钥，并为 Host 完成飞书应用配置与登录；其他设备看不到这些入口。

模型密钥只发送给 Host，保存在配置旁的私密文件中，界面只显示是否已配置和指纹。写入后需重启 Host 生效；Host 启动环境变量里已设置的同名密钥优先，界面会标明“来自 Host 环境”。若该私密文件损坏，Host 会忽略它并保留原文件，不会因此拒绝启动；手机端会提示重新输入受影响的密钥。

飞书授权在 Host 上进行：手机点“登录飞书”，打开 Host 给出的授权页完成确认后点“完成”。等待确认期间手机显示“等待在授权页确认”；授权页过期或确认失败时点“重新开始登录”，之前的授权链接随之失效。手机自己的飞书令牌不会转交给 Host。

## 验收边界

自动测试可以证明密文协议互通、幂等重试、冲突与 ID 重映射、真实网络补拉、配对与撤销、推送厂商边界前的处理。iOS NSE 与系统权限、Android Doze/force-stop、小米锁屏与隔夜到达必须在有签名和厂商账号的真机验收。缺少这些证据不能宣称 M0/M5/M6 真机验收完成。验收矩阵见 [设计里程碑](../design-notes/2026-10-23-space-host-client-milestones.md)。
