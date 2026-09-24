<a id="qr-配对-v1"></a>
<a id="对话呈现"></a>
# Nova 私有客户端协议 v1

<a id="nova-private-client-protocol-v1"></a>

远端入口为 `/client/v1`，通过 Tailscale Serve 使用 WSS。本机模拟器可在回环地址上使用 WS。该端点不开放摄像头或调试面板请求；桌面端 `/` 仍是独立的旧端点。

首个帧必须是文本，且在 3 秒内到达：

```json
{"type":"hello","token":"0123456789abcdef0123456789abcdef","protocol_version":1}
```

`token` 为 128 位随机数，小写十六进制，在本机预置并存入 iOS Keychain。示例仅用于 mock。不要把凭据放进 URL。鉴权先于任何状态同步和音频。鉴权失败以 4003 关闭；协议版本不支持以 4006 关闭；路径不支持以 4004 关闭；已有并发客户端以 4009 关闭。

鉴权成功返回如下（ID 均为示例）：

```json
{"type":"client.ready","protocol_version":1,"server_instance_id":"server-uuid","connection_id":"connection-uuid","input_audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1},"output_audio":{"encoding":"pcm_s16le","sample_rate":24000,"channels":1},"capabilities":["audio","captions","projects","executor"]}
```

音频格式与现有桌面/Qwen 管线一致：输入 16 kHz、输出 24 kHz、单声道有符号 PCM16 小端。iOS 设备采集通常为 48 kHz，客户端需自行重采样。不支持的格式必须拒绝，不能在采样率不匹配时静默播放。v1 不协商压缩音频。

## 媒体

<a id="media"></a>

上行二进制帧为 1–65536 字节，长度为偶数，内容是裸 PCM16。下行沿用 `desktop-wire.ts` 的 NOVA 封帧：4 个 ASCII 魔数字节、2 字节大端 JSON 头长度（上限 2048）、UTF-8 头部字节，随后接 PCM16。头部字段为 `utterance_id`、`generation_epoch`（正的安全整数）、`sequence`（非负安全整数）。读取长度前必须先确认可用字节数足够；非 ASCII 标识符要按协议解码；无法精确表示的整数要拒绝，而不是四舍五入。


下行文本复用现有的 `caption`、`playback.clear`、`playback.alert`、`playback.terminal`、`project.state`、`executor.state`、`executor.progress`、`executor.result`、`executor.results.reset`、`executor.approval` 与 `clock.ping` 载荷。其权威编码器是 `desktop-wire.ts`、`desktop-progress.ts`、`desktop-session.ts`。客户端不得把 terminal 当作音频已播放的证据。

## 控制与回执

<a id="controls-and-receipts"></a>

客户端控制是对现有桌面控制的一层封装：

```json
{"type":"client.command","request_id":"request-uuid","connection_id":"connection-uuid","payload":{"type":"project.confirmation_decision","proposal_id":"proposal-1","confirmed":true}}
```

允许的 `payload` 沿用桌面控制 schema：`speech.onset`，`playback.started/stopped/done/cleared`，项目与审批决策，时钟 pong 以及诊断/遥测。摄像头和任意工具执行会被拒绝。执行器确认决策可带可选的 `scope: "session"`，仅当当前宿主审批提供该选项时有效，UI 必须遵循 `allowed_decisions`。

```json
{"type":"client.command_result","request_id":"request-uuid","status":"applied"}
```

`applied` 是宿主回调给出的投递回执，**不代表**方案已被采纳或任务已执行；结果由宿主状态事件决定。`rejected` 表示重试冲突、容量不足或回调失败；`stale` 表示 connection ID 不匹配。每条连接最多记住 256 条控制，失败过的也算。相同 ID 加相同的规范化 payload 返回原回执；payload 改变后不能重新投递。容量用满时，服务端在发出回执后以 4008 关闭，客户端重连以获取新快照。控制按顺序串行处理；审批绝不跨连接边界自动重试。

文本控制上限 16 KiB；数字必须有限，整数须在 JS 安全范围内。输入缓冲上限 256 KiB / 128 条待处理消息，输出上限 256 KiB / 128 条待发送消息。任一超限即淘汰当前连接，但不会停掉 Runtime 图。重连后不回放音频积压。

断开连接时，清空本地音频和可操作的审批 UI。收到新的 ready 后使用其 connection ID。同一 server instance 会恢复内存中的项目/任务/结果状态；instance 不同说明服务已重启，不能视为任务被透明恢复。客户端挂断只是断开连接，不会取消 Codex 任务。

## 媒体选择（向后兼容的 v1 扩展）

<a id="media-selection-backward-compatible-v1-extension"></a>

新客户端在 `hello` 中带上 `media: {transports: ["host_pcm_v1"]}`。

`hello` 还可带 `language: "zh-CN" | "en"`。宿主在鉴权之后、接受输入之前校验该枚举值，用它为本连接选择翻译后的 AI 系统指令（包括任务旁白）。它不翻译用户消息，不强制回复语言，也不改 ASR/TTS 模型或音色。省略该字段则回到宿主配置的默认值（`LANGUAGE`，否则为 `zh-CN`），而不是继承上一个客户端的选择。取值不支持时拒绝连接。relay 和两种 AOQ 模式都支持该字段，旧宿主可能忽略它。客户端修改语言后需重连才能生效。

鉴权后的宿主选择其配置的管线，并在 `client.ready` 中返回：

```json
{"media":{"transport":"host_pcm_v1","path":"relay","audio_owner":"client","pipeline":"integrated"}}
```

`pipeline` 取 `integrated` 或 `cascaded`，来源于构造生产 provider 时使用的同一份已校验配置，与媒体路径无关。Qwen integrated 与支持的火山引擎 cascaded 配置共用同一套传输、审批 UI、连接身份和 PCM 格式。任何 provider 凭据、URL、原始事件或 SDK 对象都不会穿过这份契约。

不提供 offer 等同于原始 v1 relay。显式 offer 必须包含 1–8 个有界传输名且含 `host_pcm_v1`，否则服务端在 **Runtime 准入之前**以 4006 关闭。同时提供 AOQ 和 relay 的客户端会收到明确的 relay 选择；只提供 AOQ 会被拒绝。offer 中的未知字段也会被拒绝。新版 iOS 客户端要能接受不带 `media` 的旧宿主，但在麦克风启动前就要拒绝任何显式不支持的 path、owner、pipeline 或畸形描述符。每条连接只有一条媒体路径，切换需断开重连。`connection_id` 与已有的 playback/provider generation 各自保持独立归属；该扩展不会在 `client.ready` 中伪造 provider 会话身份。

direct 模式和 provider 控制消息刻意未开放：把 provider 原始事件当作 `client.command` 接收，或返回 AOQ token，都会破坏现有的授权与播放契约。

未配置或测试用传输会省略 `media`，而不是编造生产管线。已配置的描述符须严格校验，并在分配监听器前复制；多余字段（包括凭据）都会被拒绝。

## 二维码配对 v1

<a id="qr-pairing-v1"></a>

所有媒体模式共用配对流程，现有的 `hello` 和媒体协议保持不变。

- 二维码载荷：`{type:"nova.pair",version:1,server:"wss://host/client/v1",code:<32 位小写十六进制>}`。仅允许 WSS，拒绝带 userinfo/query/fragment 或路径无关的地址。客户端在交换前先展示目标地址。新邀请不再带 `expires_at`；更新过的客户端扫描旧服务端邀请时仍要校验它。
- `/client/pair`：发送一个文本帧 `{type:"pair.redeem",code,device_name}`。成功返回 `{type:"pair.ready",token,device_id}`；失败返回 `{type:"pair.error",message}`。一个 socket 处理一次响应后关闭。这里不接受麦克风、不分配模型，也不放行宿主控制。
- `/client/pair-admin`：一个文本请求，用主 `token` 鉴权。`pair.create` 接收 `server`，返回二维码载荷；`pair.list` 返回 `{type:"pair.devices",devices:[{id,name,created_at}],pairing_active}`。可选的 `code` 用于检查某个邀请是否仍有效。`pair.revoke` 接收 `device_id`；`pair.cancel` 接收 `code`；两者都返回当前设备列表。设备 token 不能调用这些操作。
- 每个进程同时只有一个活跃的 128 位随机邀请，没有基于时间的过期，设备持久化注册完成后同步消费。新邀请会替换旧邀请。并发配对/管理 socket 上限 8 个，请求上限 4096 字节，socket 生命周期 5 秒，每宿主每分钟 60 次兑换尝试，已注册设备上限 32 台。
- 每次成功交换签发一个独立的 128 位设备 token。私有存储只保存 token 哈希，并绑定到主 token。relay 和两种 AOQ 模式都在各自的正常 `hello` 中接受这些 token。撤销设备时先持久化删除，再以 4003 关闭该设备的活动 socket。
- 配对请求和凭据不得写日志、不得放进 URL 参数、不得自动重试。如果投递或本地 Keychain 持久化失败，就重新生成邀请并删除那个孤立设备条目。网络可达性和 TLS 仍是前提条件。

### 级联可编辑输入

级联主机的 `client.ready.capabilities` 会声明 `text_input`、`dictation`。以下 payload 复用绑定 connection_id、request_id 的 `client.command` 与去重回执：

- `input.text`：`text` 为非空、最长 4000 个 UTF-16 单元的用户文本。
- `input.dictation`：`id` 为草稿 ID，`action` 取 start/finish/cancel。start 后二进制 PCM 仅进入有界草稿缓冲（16 kHz PCM16，最多 60 秒）；finish 仅调用当前级联 ASR，30 秒超时；cancel 或断线都会取消识别。
- `input.audio`：结束草稿输入模式，显式恢复连续语音；草稿完成后的迟到音频不会自动进入模型。

识别结果返回 `input.transcription`，含匹配的 `id` 和 `text`，失败时只返回 `error: recognition_failed`。草稿不算用户轮次，不触发 LLM 或工具；客户端必须显式发送编辑后的 `input.text`。

## 会话呈现

<a id="conversation-presentation"></a>

iOS UI 默认处于实时模式。只有当宿主选中级联媒体并同时声明 `text_input` 和 `dictation` 时，才提供文字聊天；该能力一旦消失，UI 回到实时模式。切换 UI 模式不会重新配置宿主管线。进入文字模式会暂停实时音频；离开时会取消进行中的听写，同时保留可编辑的文字草稿。

Swift 客户端把字幕累积为内存中的会话列表，按 `message_id`／最终文本更新同一条消息，而不是把每段 partial caption 渲染成新回复。这属于客户端呈现层，不是远端历史分页 API，也不保证跨应用重启持久化。桌面端的内存历史分页走其本地的宿主接口。审批决策仍通过现有的连接绑定命令契约完成。
