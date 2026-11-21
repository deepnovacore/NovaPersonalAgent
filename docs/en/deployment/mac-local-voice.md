# Run the Mac Local Voice Stack with Docker

On an Apple Silicon Mac, one install command gives you Chinese speech recognition, chat, speech synthesis and text embeddings behind a single address. A Docker container provides the gateway and dashboard; the install script starts the model processes on macOS so Ollama and MLX can use the Mac's GPU. The public image is started with the command below; no Compose file is needed.

## Install and start

You need an Apple Silicon Mac with Homebrew and Docker Desktop. The first install downloads dependencies and models over the network. The model directory for this install is about 6 GiB; the Python environments, download cache and Docker image need extra space. The install script adds Node.js, Ollama and uv if they are missing. If an older Node.js is already installed, make sure `node` in your terminal resolves to version 24 or later first.

Run this in a Mac terminal. It pins the image digest used for acceptance:

```sh
docker desktop start
docker info >/dev/null
export NPA_IMAGE=fishwowater/npa-local-voice-stack@sha256:a264e1beb6fe3d9ea8b424ad09c748ad8252619823b2cd1b93e3188ae47865b0
set -o pipefail
docker run --rm --entrypoint cat "$NPA_IMAGE" /bundle/install.sh | bash
```

When you see `Ready: http://127.0.0.1:18134/`, you can open the [local dashboard](http://127.0.0.1:18134/) to watch requests. Check the gateway and models:

```sh
curl -fsS http://127.0.0.1:18134/health
```

A healthy stack returns HTTP 200 with top-level `ready` and `asr`, `tts`, `embedding`, `llm` and `llm_replica` under `services` all `true`. The gateway listens on loopback only and needs no API key.

## Connect Nova Personal Agent desktop

1. On the same Mac that runs the stack, open Nova Personal Agent and go to **Settings → Models → Voice pipeline**.
2. Click **Import voice preset** and choose [mac-local-voice-preset.json](../../zh-CN/deployment/mac-local-voice-preset.json). If you are reading this on the web, download the raw JSON to your Mac first.
3. After the "Preset imported. Save to apply." note appears, confirm that the pipeline is cascaded, that speech recognition, the conversation model and speech synthesis are all self-hosted, that all three endpoints point to `127.0.0.1:18134`, and that the conversation model is `openbmb/minicpm-v4.7:1b`. Leave the API key empty for the local gateway. Click **Save** and restart when the settings page asks.
4. Open the [local dashboard](http://127.0.0.1:18134/), start a new voice session in Nova and say "你好，请用一句话介绍自己" ("Hi, introduce yourself in one sentence"). Confirm that Nova shows the transcript and speaks a reply, and that the dashboard shows new ASR, LLM and TTS requests for this turn. That confirms the turn went through the local gateway.

This preset configures only the three stages of a voice session. Test the embedding endpoint separately as shown below; Nova's memory embedding settings are managed on their own.

## Verify real inference

All examples go through the Docker gateway and can be run one after another in the same terminal. The models and ASR are Chinese, so the request texts stay in Chinese.

**Chat**　Ask MiniCPM a question with a definite answer ("Which city is the capital of China? Answer with the city name only."). Check `choices[0].message.content`; the expected answer is `北京` (Beijing).

```sh
curl -fsS http://127.0.0.1:18134/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"openbmb/minicpm-v4.7:1b","messages":[{"role":"user","content":"中国的首都是哪座城市？只回答城市名。"}],"max_tokens":32}'
```

**Text embeddings**　BGE turns a Chinese phrase ("tomorrow's meeting schedule") into a 512-dimensional vector.

```sh
curl -fsS http://127.0.0.1:18134/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-small-zh-v1.5-int8","input":"明天的会议安排","input_type":"query"}' | \
  node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).data[0].embedding.length))'
```

**Speech synthesis**　Breeze returns 24 kHz mono 16-bit little-endian PCM. The command saves the raw audio ("Hello, welcome to the local voice service.") and prints its size. With FFmpeg installed, play it with `ffplay -autoexit -nodisp -f s16le -ar 24000 -ch_layout mono "$pcm"`.

```sh
pcm=$(mktemp -t npa-speech)
curl -fsS http://127.0.0.1:18134/v1/audio/speech \
  -F 'text=你好，欢迎使用本地语音服务。' -o "$pcm"
wc -c "$pcm"
```

**Chinese speech recognition**　Verify Paraformer with the two-second Chinese sample shipped in the install. The command uses the WebSocket built into Node.js 24, streams the sample's PCM data and prints the final transcript. The sample is the first two seconds of a sentence, so the transcript is a fragment; a non-empty transcript and exit code 0 mean it passed.

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const wav = readFileSync(homedir() + '/Library/Application Support/npa-local-voice-stack/serving/fixtures/warmup-zh.wav');
const pcm = wav.subarray(44); // The bundled sample uses a standard 44-byte PCM WAV header.
const ws = new WebSocket('ws://127.0.0.1:18134/v1/audio/stream');
const timer = setTimeout(() => { console.error('Recognition timed out'); process.exit(1); }, 30000);
let received = false;
ws.onmessage = ({data}) => {
  const msg = JSON.parse(data);
  if (msg.type === 'ready') {
    for (let i = 0; i < pcm.length; i += 6400) ws.send(pcm.subarray(i, i + 6400));
    ws.send('finish');
  }
  if (msg.final) { received = Boolean(msg.text?.trim()); console.log(msg.text); }
};
ws.onerror = () => console.error('Could not connect to the speech recognition service');
ws.onclose = () => { clearTimeout(timer); process.exitCode = received ? 0 : 1; };
JS
```

## Day-to-day use and troubleshooting

Models, virtual environments and logs live in the current user's install directory. Start and stop the stack from a Mac terminal:

```sh
stack="$HOME/Library/Application Support/npa-local-voice-stack/stack"
"$stack" status
```

`"$stack" stop` stops the container and the local model processes; `"$stack" start` starts them again. After starting, check the whole stack with `/health` as above.

- If `docker info` cannot connect, open Docker Desktop, wait for the engine to be ready and rerun the install command.
- If the first download is interrupted, rerun the same install command to reuse what has already downloaded. Once the install directory and container exist, the install command only starts the existing stack; it does not replace the image or the install directory, and changing `NPA_IMAGE` does not upgrade an existing container. The stack uses local ports 18130–18136; if one is taken, find the owner with `lsof -nP -iTCP:18130-18136 -sTCP:LISTEN`.
- If the gateway reports errors, run `docker logs --tail 50 npa-local-voice-stack`. If a model is not ready, check that process's log under `outputs/serving/` in the install directory.

The image and model weights are distributed separately. Breeze-TTS-2 weights and self-hosted output are subject to its research and non-commercial license. [Public image](https://hub.docker.com/r/fishwowater/npa-local-voice-stack) · [Breeze-TTS-2 model card](https://huggingface.co/BreezeBlue/Breeze-TTS-2)

## Local acceptance record

On 2026-11-20, on an Apple Silicon Mac, reusing existing models and install directory. The running container was created from the `:latest` tag, which resolves to the same digest pinned above; `/health` reported the gateway and both LLM instances ready. This run did not cover a first install into an empty directory, nor speaking through step 4 of "Connect" in the desktop app.

| Endpoint | Result |
|---|---|
| Chat | Returned `北京` (Beijing). |
| Text embeddings | Returned a 512-dimensional vector. |
| Speech synthesis | Received 142,080 bytes of PCM (`Content-Type: audio/pcm`), 2.96 s of audio at the endpoint format. Data only; not listened to. |
| Chinese recognition | Final transcript "报告警告称没" (the sample is a cut-off sentence), exit code 0. |
| Nova protocol smoke | `node serving/smoke.mjs` in the repository with this preset and the sample above: Nova runtime's ASR, LLM and TTS clients passed through the gateway — recognition reached final, the LLM made a tool call and received its result, TTS cancelled cleanly, and the full pipeline produced 545,280 bytes of audio. |
