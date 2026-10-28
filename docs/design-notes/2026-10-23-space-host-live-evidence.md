# Space Host real provider acceptance

2026-10-23 UTC. The user explicitly authorized requests to the configured real model API. Only a synthetic request about a fictional paper boat was sent. No personal sources, real message recipients, or push vendor credentials were used.

The repeatable command is:

```sh
node runtime/scripts/live/space-host.mjs --build-dir=/path/to/isolated/runtime-build --output=/path/to/private/evidence
```

The script reads the existing `NOVA_AUDIO_AGENT_MODEL_BASE_URL` / `MODEL_BASE_URL`, `DASHSCOPE_API_KEY` / `MODEL_API_KEY`, and selected model settings. It uses the production `conversationRuntimeFactory`, normal cascaded text provider and actual HTTP model API. The synthetic Client uses signed pairing, JOSE encryption, the real local HTTP/WebSocket Relay and the production Host controller. Managed-environment proxy settings are honored with normal TLS verification. Credentials, private keys, pairing secrets and envelope bodies are absent from the report; temporary Space credentials and conversation stores are removed on completion.

Passed run `54e4a2a1-5b2b-4b28-a71e-03afd011ea3e`, operation `live_54e4a2a1-5b2b-4b28-a71e-03afd011ea3e`:

- Provider: DashScope, model `qwen3-vl-plus`, actual HTTP status 200. The configured compatible endpoint uses the `self-hosted` routing option; usage identifies the provider as Qwen.
- Provider request ID: `chatcmpl-e322696e-407b-97b4-831f-439a9ea4dd55`.
- Actual model requests: **1**, duplicate model requests: **0**, usage **13,036 input / 114 output tokens**.
- Client received a real `chat.delta`, disconnected, and reconnected after the Host persisted its result. The mailbox delivered the completed final reply, 463 characters.
- Duplicate signed intents sent during execution and after completion preserved one durable user turn and did not make another provider request.
- Full run duration: **7,198 ms**. Submission 15:54:00.171, first preview/disconnect 15:54:04.414, Host completion 15:54:04.455 UTC.
- Client has only crypto/Relay SDK operations; the production Host conversation factory owns the observed provider HTTP request and conversation usage attribution.

Private execution artifacts: `/workspace/work/host/live-provider/report.json` and `/workspace/work/host/live-provider.log`. These are execution evidence, not runtime configuration.

Earlier harness attempts exposed an overlong stream TTL, direct Node fetch ignoring the environment HTTPS proxy, and a harness lookup using an unhashed operation ID instead of the Host's internal request ID. They were corrected in the acceptance script; none is reported as a passing run, and no fake model response was substituted.

Separately, the isolated TypeScript build passed and Host unit, real HTTP/WS network, and real Git-backed MemoryLedger composition tests passed **15/15**, including the source-processing status increment. The disabled personal-memory composition verifies explicit phone source ingestion and Life in the private Space ledger while automatic conversation capture remains disabled. Physical device behavior and push vendor delivery are not covered by these live runs.

## Source-processing acceptance and display boundary

The source extension runs with `--source-only` (or `--source-input` to include chat). It sends a synthetic phone source through the real encrypted mailbox, keeps automatic personal-memory capture disabled, and lets the production Host's built-in Source Agent select tools and perform genuine model processing. The provider call ceiling is 20 source requests; the source deadline is ten minutes. No model output or Agent tool decision is replaced with a fixture.

The distinction shown to a Client is upload acceptance versus Host processing state. `source_processing` exports only `status` and `needs_update`, with unknown states normalized to `idle`. Inferred profile sections, source records, references, permissions, task history and detailed errors remain excluded, as required by architecture §7.2. The increment's regression first failed on the missing status field; after implementation it passed and verified private inferred text and source identifiers remain absent.

The first genuine source run `6b9b1f85-3bf6-4499-897a-9e3eb4e5db1a` completed its Host pipeline and consent checks in 337.6 seconds, making 11 source model requests. Its raw report deliberately remains **failed** because the original harness's final assertion incorrectly demanded inferred profile export to the Client. That expectation contradicted the documented privacy boundary and was removed from the harness. It is not counted as a fully passed acceptance run. Its actual Host results were one project, two suggestions, an about section and three work sections in the canonical ledger, with Host presentation `ready`; processing revocation made no further model request, and upload revocation deleted the original and rejected a later fact. The original evidence is preserved as `live-source/first-run-harness-failure.json`.

The corrected source-only run **passed**, without repeating chat:

```sh
node runtime/scripts/live/space-host.mjs --source-only --build-dir=/workspace/work/host/dist --output=/workspace/work/host/live-source2
```

- Acceptance run: `4201596d-629f-48ad-95e8-54c072d8f3b7`.
- Actual Host scheduled run: `43fff6adf8569955b85c86d968c42331c6750511f59120b231fe9ca06fafaf1f`; task `5cb9174f-50a8-42c0-b5b6-bf68e83ef34c` ended `completed`.
- DashScope `qwen3-vl-plus`: **11 genuine model requests**, all HTTP 200; **28,184 input / 17,532 output tokens**. Four Agent requests and seven products/profile generation and verification stages are separate requests, not duplicated executions of the same chat operation.
- Duration: **308,053 ms**, 16:06:12–16:11:18 UTC. The configured ten-minute / twenty-request limits were respected.
- The one canonical Host ledger held one project, two suggestions, an about section and two work sections; Host final presentation was `ready`.
- A real encrypted durable Relay snapshot delivered `source_processing:{status:'ready',needs_update:false}` to the synthetic Client. Raw evidence and inferred profile partitions were absent. No Timeline/feed card was generated in this minimal fixture, so this run makes no claim about a new source-derived card.
- Upload without a grant was rejected before any model request. Upload-only consent stored the original in the Host ledger without authorizing model processing. Processing consent enabled the genuine built-in Agent. Revoking processing removed extraction authorization and made no additional model request. Revoking upload deleted the original and rejected a subsequent fact.
- All eight source checks passed. The raw report remains unchanged at `/workspace/work/host/live-source2/report.json` (mode 0600); `source.profile.status` is its final status, while the earlier progress sample `host_profile_status` was recorded during processing. Request IDs and usage are included; keys and raw model/source content are excluded.

Representative provider request IDs are `chatcmpl-cf82a220-7137-9d15-a7af-4e1cb5ecac62` (Agent), `chatcmpl-8bb06e9e-ffa4-9bfc-b1aa-9a39196a1821` (products), and `chatcmpl-35deede8-2364-9364-a180-e0c8e86db6c1` (final profile evidence verification). These are execution evidence, not synthetic response identifiers.
