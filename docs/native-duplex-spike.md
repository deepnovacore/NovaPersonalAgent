# Native duplex voice spike

This branch is a research spike, not a released desktop feature. It adds runtime configuration and a bounded service probe for SGLang-Omni MiniCPM-o 4.5 and PersonaPlex. The existing Qwen, StepFun, OpenAI, Gemini and cascaded agent routes remain available. No model weights, credentials or private deployment addresses belong in this repository.

## Capability contract

`runtime/src/realtime/capabilities.ts` separates effective model capabilities from the capabilities exposed by a particular service adapter. A WebSocket transport or OpenAI-shaped event name does not imply tool calls, history restoration or cancellation are supported. New production adapters declare both groups; the optional interface field preserves existing third-party adapters and test doubles.

| Capability | Existing agent routes | SGLang MiniCPM-o | SGLang PersonaPlex |
| --- | --- | --- | --- |
| `model.functionCalling` | Available; provider evidence checks still apply | false | false |
| `model.audioInput` / `audioOutput` | true | true | true |
| `model.textInput` | true | false | false |
| `model.textOutput` | true | assistant transcript | assistant transcript |
| `model.nativeFullDuplex` | false in these adapters | true | true |
| `protocol.conversationItems` | true | false | false |
| `protocol.clientResponses` | true | false | false |
| `protocol.mutableSession` | true except Gemini setup replacement | false | false |
| `protocol.restoreConversationContext` | true | false | false |
| `protocol.cancelResponse` | true | false | false |
| `protocol.inputTranscription` | true | false | false |
| `protocol.responseBoundary` | turn | model turn | entire session |

These are adapter capabilities, not claims that all variants of a model support the same features. Gemini's existing audio/tool evidence restrictions remain in place. MiniCPM image/video input is outside this voice spike.

The shared provider session strips tool schemas for conversation-only models and rejects unsolicited normalized tool events. Unsupported text input, host items, host-created responses and cancellation fail explicitly. The host suppresses proactive item delivery, rolling memory/project-context injection and local-VAD cancellation for these native providers. Natural overlap remains the model's decision. Closing the session stops the stream; a local microphone onset does not destroy its context.

A native serving key is never forwarded to the cloud support-model gateway. Without an explicitly configured generic support model, auxiliary work fails locally. Normal host module configuration still applies: disable unused modules or supply their own credentials. This does not disable other separately configured text-agent conversations.

## Events and audio

```text
microphone PCM16, 16 kHz
          |
          v
SglangNativeDuplexAdapter
  MiniCPM: 16 kHz PCM16
  PersonaPlex: resample to 24 kHz PCM16
          |
          v
SGLang /v1/realtime WebSocket
          |
          v
24 kHz PCM16 + assistant text -> Nova playback/captions
```

Handshake: `session.created` -> `session.update` -> `session.updated`. All client frames include `event_id`. Audio appends carry monotonically increasing `sglang.seq` and are sent at capture speed. Final input uses `sglang.input_audio.end`; the client drains responses, awaits `sglang.input_audio.drained`, then sends `session.close`.

`response.created`, output audio/transcript deltas, transcript done and `response.done` map to Nova's existing normalized events. No user speech events, user transcript, user authorization, or artificial turn-end events are manufactured.

MiniCPM's `OutputConverter` finishes responses on model `end_of_turn` or end-of-stream. PersonaPlex retains one response for the session. Neither receives a synthetic response terminal merely because VAD observes silence. Separate user turns and durable user/assistant history require a separately designed observation/segmentation path; that path must not invent tool authorization.

## Configure the research runtime

The desktop integrated-provider picker includes both experimental models. Save each service endpoint and its independent encrypted key, then use “检查已保存的服务配置”. PersonaPlex voices are fetched by the main process; the renderer never receives the key. MiniCPM voice selection remains server-owned.

The equivalent runtime/CLI environment is:

```sh
PIPELINE_MODE=integrated
INTEGRATED_PROVIDER=minicpm-o # or personaplex
NATIVE_REALTIME_URL=ws://127.0.0.1:8000/v1/realtime
# NATIVE_REALTIME_API_KEY=... # only if the deployment requires it
# NATIVE_REALTIME_VOICE=NATF2 # PersonaPlex only; otherwise use server default
```

Remote endpoints require `wss`; use a loopback SSH tunnel for a remote plain-WebSocket deployment. URL credentials and query-string secrets are rejected. The MiniCPM voice is configured on the server, not via the PersonaPlex voice-name option. A native session starts fresh: typed messages, imported history, tools, proactive announcements and persistent memory injection are unavailable. There is no cloud fallback.

## Reproducible service probe

Compile the runtime into the worktree/chat's external output directory first. `NOVA_TEST_DIST` can select that directory. The probe accepts raw mono 16 kHz PCM16, at most 300 seconds, adds three seconds of listening tail, and has a 360-second overall deadline. It checks server native capabilities and sample rates before opening the socket. Use a new output directory on the external disk.

```sh
NATIVE_REALTIME_URL=ws://127.0.0.1:8000/v1/realtime \
  node runtime/scripts/native-duplex-smoke.mjs minicpm-o caller-16k.pcm NEW_OUTPUT_DIRECTORY
```

Success requires audio and a completed server response; the output is `reply-24k.pcm` and `result.json` (assistant transcript, timings, capabilities). A successful socket handshake alone is not acceptance. Files may contain conversation content; keep them private.

`runtime/scripts/native-duplex-smoke.test.mjs` exercises the actual CLI and WebSocket transport against a local protocol fixture, including both input sample rates. `runtime/test/sglang-native.test.ts` covers capability gates, malformed frames, cancellation, native boundaries, credentials and assembly construction. Fixture success is not real-model validation.

Validated in this spike: TypeScript compilation; lint on all changed TypeScript files; 12 native adapter tests, three localhost-WebSocket CLI tests and three conversation factory lifecycle tests; existing Qwen/Gemini, provider-session, integrated factory, service orchestration, configuration and documentation regressions. The actual Electron source-startup smoke loaded the renderer and settings using the existing application profile. The isolated Ubuntu 22.04 serving environment installed the pinned dependencies; CPU import confirmed Torch 2.14.1+cu130, and the SGLang serve CLI help preflight passed. Subsequent GPU validation is recorded below.

## Serving research and remaining gates

Reviewed SGLang-Omni source: `35e973de917988da23eeba5706c1d6045f260104` (2026-10-23). The checked-in documentation still references removed `examples/full_duplex/minicpmo.yaml`; the actual model registry exposes a `session` variant. Candidate launch commands, pending real-model validation:

```sh
python -m sglang_omni.cli serve --model-path openbmb/MiniCPM-o-4_5 --variant session --enable-realtime --port 8000
python -m sglang_omni.cli serve --model-path nvidia/personaplex-7b-v1 --variant session --enable-realtime --port 8000
```

Pin the source and checkpoint, use the user-selected GPU 2 once enough memory is available and an unused port, then verify `/v1/realtime/capabilities` and run the probe. The current source requires Python >=3.11,<3.13 and a different Torch/SGLang stack from the existing MiniCPM environment; use an independent environment. PersonaPlex requires acceptance of its Hugging Face license and authenticated download. Model file size checks are necessary but do not prove that weights load or inference meets real-time deadlines.

A remote dependency-resolution probe found a host compatibility blocker: glibc 2.31 cannot install the current SGLang 0.5.22 wheel (manylinux >=2.34). The independent Ubuntu 22.04 container environment (glibc 2.35) now has the pinned dependency set installed. Large wheels were verified against official PyPI SHA-256 values. The host libraries were not changed. Installation and CLI import do not establish inference acceptance. The retained launcher only selects GPU 2 and refuses to start below 22 GiB free; this is a preflight threshold, not a proven model memory requirement. The user later authorized live validation on GPU 2; results are recorded below.

Known spike limits:

- Desktop configuration and capability gating are implemented. Mobile acceptance and physical microphone/speaker acceptance are not yet claimed.
- This is the SGLang native JSON/PCM dialect. ModelBest's float32 protocol, vLLM-Omni and NVIDIA's original binary protocol need separate adapters.
- Final assistant transcripts accept up to 64 KiB of UTF-8; larger finals fail explicitly. Delta and other text limits are unchanged. This does not synthesize user history or user turns.
- The adapter does not restore state after disconnection, synthesize user transcripts or support external interruption/truncation. Session errors are non-recoverable.
- No GPU performance, concurrency, acoustic echo cancellation or latency claim follows from protocol fixture tests.

Sources: [Qwen Audio Agent provider registry](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/src/voice/providers/provider-registry.mjs), [SGLang full-duplex docs](https://sgl-project.github.io/sglang-omni/developer_reference/full_duplex_interactive_model.html), [MiniCPM output conversion](https://github.com/sgl-project/sglang-omni/blob/35e973de917988da23eeba5706c1d6045f260104/sglang_omni/models/minicpm_o/session_adapters.py), [PersonaPlex session conversion](https://github.com/sgl-project/sglang-omni/blob/35e973de917988da23eeba5706c1d6045f260104/sglang_omni/models/personaplex/realtime.py).

Desktop receives generation-scoped `conversation.capabilities` and current voice capabilities in host snapshots for reconnects. Native microphone onset preserves playback and captions; ending voice closes the native provider. Identity/prepared-context injection is skipped for providers without conversation items.

## GPU validation update (2026-10-23)

PersonaPlex loaded on one RTX 4090 and completed a short audio session through Nova’s production adapter. This is **not a passing real-time acceptance**: corrected real-time replay of the 300-second fixture failed after 114.784 seconds with server `buffer_overflow`, having produced only 74.8 seconds of audio. The transcript also failed the two-to-three notebook correction. Physical audio and independent spoken-content verification remain untested.

The first cold startup hit the 600-second startup timeout during slow disk reads; read-only sequential cache warming and a longer startup timeout allowed loading. The container also needed a matching CUDA compiler/runtime set (13.0.88 compiler components with the cu130 runtime), explicit CUDA_HOME, and a full Toolkit-compatible lib64 layout. A tiny CUDA compile/link/run check passed before the successful model start. The first audio request timed out during prefill JIT; its failure was retained separately from the warm request.

MiniCPM-o first initialization exposed missing FFmpeg system libraries. Installing libavdevice58 in the private Ubuntu 22.04 image made TorchCodec 0.17.0+cu130 import successfully. Its subsequent GPU retry was blocked when other workloads occupied GPU 2; no MiniCPM-o inference success is claimed.

The smoke CLI now starts PCM pacing after the handshake, validated with a delayed-handshake regression. It records bounded service error codes for diagnosis. All three CLI fixtures pass. Earlier replay runs remain diagnostic evidence, not corrected-timing acceptance.

## Dual-GPU acceptance and diagnosis (2026-10-24)

MiniCPM-o single-card startup exhausted memory during CUDA Graph capture. Splitting thinker and audio stages across two RTX 4090s completed a 300-second paced PCM replay through Nova, with 10.52 seconds of reply audio and no service error. All three transcript checks passed: Alex/two notebooks, correction to three, and recalling Alex/three. This is replay and transcript acceptance, not physical audio or independent listening acceptance.

PersonaPlex still failed: single GPU overflowed after 116.391 seconds; splitting LM and codecs onto two GPUs overflowed after 108.554 seconds, yielding 68.4 seconds of audio. A direct 24 kHz WebSocket client bypassing Nova reproduced slower-than-realtime throughput, including with bit-identical Nova-resampled PCM. Official per-unit profiling over 188 units measured median admitted-to-finished 128.58 ms against an 80 ms budget; LM service alone was 81.69 ms and Mimi encoding 23.68 ms. Extra VRAM does not remove same-session sequential dependencies.

The official [session optimization roadmap #3083](https://github.com/sgl-project/sglang-omni/issues/3083) identifies one-row extend rather than the optimized decode path, missing Depformer graphs and eager Mimi encoding. Pending [warmup PR #3104](https://github.com/sgl-project/sglang-omni/pull/3104) addresses first-unit latency but explicitly does not establish the 80 ms steady budget. [Depformer graph PR #2682](https://github.com/sgl-project/sglang-omni/pull/2682) is promising but its reported offline GPU results are not 4090 session acceptance. These changes were not applied; the tested source remains the fixed commit above.

Environment checks found no CPU quota, CPU offload, or obvious thermal clock reduction. Initial dependency layout and FFmpeg issues were repaired; cold disk reads and first-request JIT remain relevant startup costs. This does not rule out CPU/kernel configuration effects. No matched NVIDIA Moshi backend comparison has been performed, and content errors cannot yet be attributed solely to the model or resampling. PersonaPlex remains a research provider, not a passing realtime deployment.

## A800 comparison (2026-10-24)

A single A800-SXM4-80GB completed the same 300-second paced input through the production Nova adapter, with 303.12 seconds of PCM including the silence tail, a completed response at 303.127 seconds, and no service error. Official profiling measured 73.80 ms median per unit in the warm short test (188 units), and 73.65 ms in the latter part of the long test (1698 complete units), below the 80 ms budget. Median admission queue time remained about 0.21 ms in the long sample. This is a passing five-minute transport/throughput check; the transcript still failed initial notebook count and name recall, so full dialogue acceptance remains failed.

The SGLang commit, model revision, copied Python/Torch/SGLang dependencies and PCM inputs were unchanged. The CPU, driver, thread allocation, base system image, automatic KV pool and client location differed: Xeon Platinum 8350C, driver 595.71.05, 32 scheduled CPUs, a minimal Ubuntu 22.04 image, and a node-local Slurm probe. This is a deployment comparison, not an isolated GPU benchmark. It establishes that the current SGLang version can sustain this workload on the tested A800 deployment; previous 4090 overflow cannot be attributed solely to a universally slow SGLang path or Nova. Whether further tuning makes the 4090 deployment realtime is still unproven.

The test container was stopped after evidence capture. No physical microphone/speaker, independent listening, concurrency or NVIDIA reference-backend parity acceptance was performed.
