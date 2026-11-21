# 用 Docker 启动 Mac 本地语音推理服务

在 Apple Silicon Mac 上运行一条安装命令，即可通过同一地址调用中文语音识别、聊天、语音合成和文本向量服务。Docker 容器提供网关和看板，安装脚本在 macOS 上启动模型进程，让 Ollama 和 MLX 可以使用本机 GPU。公开镜像的启动入口是下方命令，无需下载 Compose 文件。

## 安装与启动

准备一台 Apple Silicon Mac，安装 Homebrew 和 Docker Desktop。首次安装需要联网下载依赖和模型。本次安装的模型目录约 6 GiB，Python 环境、下载缓存和 Docker 镜像还需要额外空间。安装脚本会补装缺少的 Node.js、Ollama 和 uv；如果已安装较旧的 Node.js，请先让终端中的 `node` 指向 24 或更高版本。

在 Mac 终端执行。下面固定了验收使用的镜像摘要：

```sh
docker desktop start
docker info >/dev/null
export NPA_IMAGE=fishwowater/npa-local-voice-stack@sha256:a264e1beb6fe3d9ea8b424ad09c748ad8252619823b2cd1b93e3188ae47865b0
set -o pipefail
docker run --rm --entrypoint cat "$NPA_IMAGE" /bundle/install.sh | bash
```

看到 `Ready: http://127.0.0.1:18134/` 后，可打开[本机看板](http://127.0.0.1:18134/)查看请求。检查网关和模型：

```sh
curl -fsS http://127.0.0.1:18134/health
```

正常时返回 HTTP 200，顶层 `ready` 及 `services` 下的 `asr`、`tts`、`embedding`、`llm`、`llm_replica` 都为 `true`。网关仅监听本机回环地址，无需 API 密钥。

## 接入 Nova Personal Agent 桌面端

1. 在运行推理栈的同一台 Mac 上打开 Nova Personal Agent，进入 **设置 → 模型 → 语音管线**。
2. 点击 **导入语音预设**，选择本文同目录的 [mac-local-voice-preset.json](mac-local-voice-preset.json)。在网页上阅读时，先将链接中的原始 JSON 下载到本机。
3. 看到“预设已导入，请保存”后，确认当前采用级联语音，语音识别、对话模型、语音合成都选择自托管，三个端点都指向 `127.0.0.1:18134`，对话模型为 `openbmb/minicpm-v4.7:1b`。本机网关的 API Key 留空。点击 **保存**，按设置页提示重启。
4. 打开[本机看板](http://127.0.0.1:18134/)，回到 Nova 开一个新语音会话，说“你好，请用一句话介绍自己”。确认 Nova 显示识别文字并播出回复，同时看板上能看到本轮新增的 ASR、LLM 和 TTS 请求。这样可以确认这轮对话经过了本机网关。

这份预设只配置语音会话的三个阶段。向量接口可按下节独立测试，Nova 的记忆嵌入配置单独管理。

## 验证真实推理

以下示例均通过 Docker 网关。可在同一终端依次执行。

**聊天**　请求 MiniCPM 回答一个有确定答案的问题。检查返回的 `choices[0].message.content`。

```sh
curl -fsS http://127.0.0.1:18134/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"openbmb/minicpm-v4.7:1b","messages":[{"role":"user","content":"中国的首都是哪座城市？只回答城市名。"}],"max_tokens":32}'
```

**文本向量**　BGE 对一段中文生成 512 维向量。

```sh
curl -fsS http://127.0.0.1:18134/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-small-zh-v1.5-int8","input":"明天的会议安排","input_type":"query"}' | \
  node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).data[0].embedding.length))'
```

**语音合成**　Breeze 返回 24 kHz、单声道、16 位小端 PCM。下面保存原始音频并显示字节数。安装了 FFmpeg 时，可用 `ffplay -autoexit -nodisp -f s16le -ar 24000 -ch_layout mono "$pcm"` 试听。

```sh
pcm=$(mktemp -t npa-speech)
curl -fsS http://127.0.0.1:18134/v1/audio/speech \
  -F 'text=你好，欢迎使用本地语音服务。' -o "$pcm"
wc -c "$pcm"
```

**中文语音识别**　用安装包自带的两秒中文样本验证 Paraformer。以下命令使用 Node.js 24 自带的 WebSocket，读取该样本的 PCM 数据并打印最终识别结果。样本截自一句话的开头两秒，结果是半句话；打印出非空文字且命令退出码为 0 即为通过。

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const wav = readFileSync(homedir() + '/Library/Application Support/npa-local-voice-stack/serving/fixtures/warmup-zh.wav');
const pcm = wav.subarray(44); // 随包样本使用标准 44 字节 PCM WAV 头。
const ws = new WebSocket('ws://127.0.0.1:18134/v1/audio/stream');
const timer = setTimeout(() => { console.error('识别超时'); process.exit(1); }, 30000);
let received = false;
ws.onmessage = ({data}) => {
  const msg = JSON.parse(data);
  if (msg.type === 'ready') {
    for (let i = 0; i < pcm.length; i += 6400) ws.send(pcm.subarray(i, i + 6400));
    ws.send('finish');
  }
  if (msg.final) { received = Boolean(msg.text?.trim()); console.log(msg.text); }
};
ws.onerror = () => console.error('连接语音识别服务失败');
ws.onclose = () => { clearTimeout(timer); process.exitCode = received ? 0 : 1; };
JS
```

## 日常启停与排查

模型、虚拟环境和日志保存在当前用户的安装目录。日常启停请在 Mac 终端使用：

```sh
stack="$HOME/Library/Application Support/npa-local-voice-stack/stack"
"$stack" status
```

用 `"$stack" stop` 停止容器和本机模型进程，用 `"$stack" start` 重新启动。启动后用上面的 `/health` 检查整个服务。

- 若 `docker info` 连接失败，打开 Docker Desktop，等引擎就绪后重跑安装命令。
- 首次下载中断时，重跑同一安装命令即可复用已完成的下载。安装目录和容器已存在时，安装命令只会启动现有服务，不会替换镜像或安装目录；更换 `NPA_IMAGE` 不会让已有容器升级。服务使用本机端口 18130–18136，若提示占用，可用 `lsof -nP -iTCP:18130-18136 -sTCP:LISTEN` 查看占用者。
- 网关报错时，运行 `docker logs --tail 50 npa-local-voice-stack`。若某个模型未就绪，到安装目录下的 `outputs/serving/` 查看对应进程日志。

镜像与模型权重分别分发。Breeze-TTS-2 的权重及自托管输出受其研究与非商业许可约束。[公开镜像](https://hub.docker.com/r/fishwowater/npa-local-voice-stack) · [Breeze-TTS-2 模型说明](https://huggingface.co/BreezeBlue/Breeze-TTS-2)

## 本机验收记录

2026-11-20，在 Apple Silicon Mac 上复用已有模型和安装目录。运行中的容器由 `:latest` 标签创建，解析到的镜像摘要与上方固定值一致；`/health` 显示网关与两个 LLM 实例均就绪。本次未覆盖空目录首次联网下载，也未在桌面端实际说话走完“接入”第 4 步。

| 接口 | 本次实测 |
|---|---|
| 聊天 | 返回 `北京`。 |
| 文本向量 | 返回 512 维向量。 |
| 语音合成 | 收到 142,080 字节 PCM（`Content-Type: audio/pcm`），按接口格式折合 2.96 秒音频。此次仅检查数据返回，未试听。 |
| 中文识别 | 收到最终转录“报告警告称没”（样本为截取的半句话），退出码 0。 |
| Nova 协议冒烟 | 在仓库中用本预设与上述样本运行 `node serving/smoke.mjs`，Nova 运行时的 ASR、LLM、TTS 客户端经网关通过：识别得到 final，LLM 完成工具调用并收到结果，TTS 可取消，完整管线产出 545,280 字节音频。 |
