# 语音管线延迟排查

默认日志：`~/.nova-audio-agent/realtime-telemetry.jsonl`。现在追加写入，重启不会覆盖；每个 writer 有独立 `run_id`，每条记录包含递增 `seq`、主机时钟秒数 `ts` 和 UTC `wall_time`。文件权限 0600。旧记录没有运行标识，不参与统计；坏行会计数并跳过。长期开启时需外部轮转或归档，当前不自动删除历史。

```sh
node runtime/scripts/realtime-latency.mjs > /tmp/nova-latency-report.json
# 多个文件也可一起分析
node runtime/scripts/realtime-latency.mjs /path/to/integrated.jsonl /path/to/cascaded.jsonl
```

输出每个响应的阶段耗时，以及按管线、模型、ASR/TTS、视觉配置分组的样本数、P50、P95（最近秩）。取消/失败/未完成响应保留在 rows 中，不参与成功延迟分位数；缺失阶段是 null。关联使用 run_id + session epoch + response/item ID，不猜测相邻事件属于同一轮。

- speech_to_audio_ms：服务端收到语音结束事件 → 收到模型/合成语音首包，两条管线相同口径。
- speech_to_playback_ms：语音结束事件 → 收到客户端开始播放的确认。包含本地传输与排队；并非物理扬声器实测。语音结束事件本身不包含检测器判断停顿之前的时间。
- asr_finalize_ms：语音结束事件 → 最终识别结果。
- llm_first_text_ms：级联调用 LLM stream 前 → 首段非空文本，包含请求准备和网络等待。原 llm.started 是首个响应事件，不是请求发出。
- text_to_tts_ms：模型首段文本 → 首次发送 TTS 文本（包含分句与连接准备）。
- tts_first_audio_ms：首次发送 TTS 文本 → TTS 首包。
- audio_to_playback_ms：服务端首包 → 播放确认。

还记录视觉取帧开始/完成、ASR 连接开始/完成、模型工具调用、provider 错误和响应终止。新增事件不记录正文、音频或密钥；既有完整 debug 事件可能含对话内容，不要直接公开整份日志。

对比时使用同样的输入、历史长度、视觉开关、网络及音频设备，分别采集多轮。工具调用后的后续响应可能关联同一个用户输入，应检查 rows 的 response_id，不能把所有响应当作独立用户轮次；没有真实样本时不要据此宣称哪条管线更快。
