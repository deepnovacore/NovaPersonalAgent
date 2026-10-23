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

   配置中包含 Host 私钥和内容密钥，不能提交仓库或放到 relay。`--data` 必须是全新路径，已有数据不会被迁移或覆盖。若网络在首次创建时中断，保留已写出的配置，使用 `resume --config /private/new-space/config.json --bootstrap-file /private/relay-bootstrap` 重试同一身份；不要删除配置重建身份。
3. 设置 `NOVA_SPACE_HOST_CONFIG=/private/new-space/config.json` 后启动桌面端。桌面的 Settings → Connections → Space 与手机可生成一次性二维码、核对手机完整指纹、确认绑定及撤销设备。
4. 手机选择“Client”，扫描二维码；在手机与桌面核对指纹后由桌面确认。Client 等待密钥投递后补拉展示数据。Host 离线时状态修改显示等待，聊天立即失败，不会等 Host 上线后悄悄发送。
5. 在手机创建其他 Space 可选独立模式或另一 Host 的 Client；每个 Space 的凭据、缓存、意图和工具执行记录相互隔离。桌面切到另一个 Host Space 需使用另一份独立配置启动。

## 通知与手机工具

锁屏通知另需部署 [push gateway](../../push-gateway/README.md) 和厂商配置。Host 私有配置的 `push_gateway_url` 固定为所信任的 HTTPS gateway；手机直接向同一 gateway 登记令牌，只把随机句柄和受限凭据交给 Host。App 内数据补拉不依赖推送成功。小米公信使用通用文案且受配额限制。

Client 的系统工具只执行 Host 明确下发的动作，并检查前台状态、系统权限、用户确认和持久化 action-id。当前包含日历读取、相机拍摄；提醒创建限 iOS，Android 返回明确不支持。Client 不运行本地模型或自主规划循环。

## 验收边界

自动测试可以证明密文协议互通、幂等重试、冲突与 ID 重映射、真实网络补拉、配对与撤销、推送厂商边界前的处理。iOS NSE 与系统权限、Android Doze/force-stop、小米锁屏与隔夜到达必须在有签名和厂商账号的真机验收。缺少这些证据不能宣称 M0/M5/M6 真机验收完成。验收矩阵见 [设计里程碑](../design-notes/2026-10-23-space-host-client-milestones.md)。
