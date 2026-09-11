# Live acceptance

Live acceptance measures real provider behavior separately from deterministic tests. A green unit
suite, a working executor, and a model selecting the right tool are different claims. The canonical
inventory is `runtime/scripts/live/catalog.json`; the runner is `runtime/scripts/live/run.mjs`.

## Layers and ownership

| Layer | Suites | Evidence | Does not prove |
| --- | --- | --- | --- |
| Provider | `qwen-audio` | Real provider session/audio contract | Business tool selection |
| Model routing | `text-tools` | Real Qwen/Ark cascaded adapter, production frontend prompt, compiled built-in schemas, synthetic user text and tool results | Host admission, executor execution, ASR/TTS |
| Model planning | `coordinator`, `qwen-surrogate` | Real downstream assess/cancel or progress decisions | Frontend choosing dispatch |
| Executor | `search-mcp`, `knowledge` | Real search/embedding/retrieval through existing smoke scripts | Model selecting these tools |
| Pipeline | `cascaded-audio` | Digital ASR/LLM/TTS, synthetic echo tool continuation, host playback seams | Physical microphone/speaker, all business tools |
| Device/product | Existing desktop installed/package smokes | Packaging, startup, configured device seams | Real model routing unless explicitly exercised |

Runtime owns the suite catalogue, fixtures, scorer and reports. A change to a tool, descriptor or
frontend prompt must review the affected routing cases. An executor change must run its executor
suite; provider/session changes must additionally run the applicable pipeline suite. Device
acceptance remains a separate release responsibility.

## Commands

From the repository root (Node 22.13+ and dependencies installed):

```sh
npm run test:live:contract --workspace @nova-audio-agent/runtime
npm run test:live --workspace @nova-audio-agent/runtime -- --list
npm run test:live --workspace @nova-audio-agent/runtime -- \
  --suite text-tools --provider qwen --repeat 3 --env-file /path/to/.env \
  --output /tmp/nova-live-qwen.json
npm run test:live --workspace @nova-audio-agent/runtime -- \
  --suite text-tools --provider ark --model doubao-seed-2-0-pro-260215 \
  --output /tmp/nova-live-ark.json
npm run test:live --workspace @nova-audio-agent/runtime -- \
  --suite text-tools --case confirm-no --provider qwen --output /tmp/confirm-no.json
npm run test:live --workspace @nova-audio-agent/runtime -- \
  --suite coordinator,search-mcp,knowledge --env-file /path/to/.env --output /tmp/executors.json
```

After a build, invoke `node runtime/scripts/live/run.mjs` directly to avoid rebuilding for every run.
`--suite` defaults to `text-tools`; there is deliberately no implicit run-all. External executor
suites need their own deployment configuration. Process environment overrides `--env-file`; the
runner never automatically reads an arbitrary checkout's `.env`. Text routing only needs the
selected LLM key (`DASHSCOPE_API_KEY` or `ARK_API_KEY`), not ASR/TTS credentials. It uses production
provider defaults unless `--model` or `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` overrides the model.
`--provider` / `--model` apply only to text-tools; legacy suites retain their existing configuration.

Ordinary CI runs the offline contract tests with no model credentials. The coordinator also requires
`NOVA_LIVE_TESTS=1` (set by the runner), so a normal unit run cannot call it merely because a key exists. The manually dispatched
`Live acceptance` GitHub workflow runs a selected live suite and uploads the JSON report for seven
days. Configure the matching repository secrets before using it. Nothing runs on a timer or every PR.

## Fixture contract and current coverage

`fixtures/live/text-tools.json` contains versioned synthetic cases. Each case specifies a stable ID,
user text, host context, optional disabled capabilities, and an ordered list of expected responses.
A response defines exact call count/name, JSON arguments, required instruction terms / reviewed equivalent phrases, forbidden parameter patterns, whether text
is required/forbidden, and optional answer evidence. A synthetic `result` continues the same model
session using the actual returned call ID. Calls are captured, never dispatched to real tools. A step with `otherwise` also allows a zero-call direct answer, scored against that separate expectation. `textAll` requires evidence from every group, unlike `textAny`, which requires only one matching term.

The current 25 cases cover:

- Ordinary conversation with zero calls.
- Search, session/personal memory, knowledge retrieval, camera snapshot.
- Coding dispatch/steering/cancel and vision dispatch/cancel.
- Explicit yes/no and ambiguous project confirmation, plus negated cancellation and discussion-only requests.
- Requests for each capability with all optional modules disabled (memory remains available).
- Empty memory, failed knowledge retrieval, and instruction injection in knowledge results.
- Result continuation, correct source attribution (`origin_ref`), required constraints and no
  unsupported extra tool calls.

Schemas come from production manifests through `compileToolSchema`; descriptions and instructions
are not copied into fixtures. JSON argument validation uses the already-installed Zod JSON Schema
converter. Offline tests pin the current seven-tool surface, cover every tool, validate fixture
structure, and test scorer failures, continuation and blocked-report behavior.

These cases are a development regression set, not an independent benchmark. Once prompts are tuned
against them, add a separately frozen holdout before claiming generalization. Do not loosen an
expectation after a failed run without documenting why the old expectation was semantically wrong.
The search case has no authoritative current date, so its query must preserve relative time rather
than invent an absolute year. Disabled-capability cases also require an unavailable explanation and
reject known false-execution claims; nonempty text alone never establishes success. Search-disabled may either explain the limitation directly or recall memory and then explain both the recall outcome and unavailable search. Coding-disabled must explain the limitation without asking for requirements or code.

Answer-keyword checks are deliberately narrow evidence checks, not a general truthfulness judge;
manual review is required for nuanced wording and for any proposed assertion change.

## Report and acceptance rules

The runner writes JSON before the first request and after every case. Reports contain schema
version, Git revision/dirty state, harness/fixture hashes and selected fixture snapshots, platform/Node, selected suites, provider
and model for text routing, per-case repeat/latency, compiled surface hash, observations and reason
codes. `caseSummary` records stability across repeats. `finishedAt` distinguishes completed runs
from interrupted partial reports. Reports apply only to their recorded selection, not the whole
product. Compare matching fixture/surface hashes before claiming an improvement.

| Status | Meaning |
| --- | --- |
| `passed` | All assertions for this selected case passed |
| `failed` | Behavioral/schema/protocol assertion failed, or a legacy suite exited unsuccessfully |
| `error` | Network, timeout, runner or process infrastructure prevented verification |
| `blocked` | Missing known credentials, invalid configuration, or retired suite |

Exit 0 means every selected result passed. Exit 1 means at least one failed. Exit 2 means incomplete
verification (error/blocked) without a behavioral failure. Empty selections cannot pass. Unknown
CLI options/cases fail before any network request. Do not count errors/blocked results as passes or
silently retry them away. Routing acceptance requires 100% on the selected cases for all requested
repeats; the recommended release run is three repeats on each deployed model. The older coordinator
eval retains its declared 8/10 dev and 7/10 holdout threshold; a process pass is not 100% case accuracy.

Legacy suites are wrapped at process level with a timeout and bounded/discarded output. Their
nonzero exit is not automatically diagnosed as a model failure. Use their native diagnostic command
for investigation; the wrapper does not pretend to have per-case observations it cannot collect.
Missing configuration only detected inside an executor may therefore appear as `failed`.

Only synthetic routing prompts/results and model responses are persisted. No keys, transport error
messages/headers, microphone audio, real memories, user documents or subprocess stdout are saved.
Reports default to a unique temporary path with owner-only creation permissions. Inspect artifacts
before sharing. A report is evidence, not an authorization or a record of executed business actions.

## Remaining coverage and legacy policy

- `qwen-clarification-legacy` and `qwen-routing-legacy` are blocked in the canonical runner. The first
  has an obsolete import/missing descriptors; the second uses handwritten hidden status tools.
  Their old npm commands now fail closed with a migration message and cannot certify the current product. Text routing
  and coordinator cover their text decisions, but current-schema voice routing remains a gap.
- External MCP tools depend on deployment discovery and are not part of the seven built-in routing
  cases. Add explicit synthetic per-deployment cases before claiming their selection is accepted.
- Full `submitText → RealtimeService → host admission → executor → delivery` live acceptance is
  separate future coverage. This suite calls the production cascaded LLM session's user-text input
  directly; it does not claim to exercise the client WebSocket or host service.
- Vision execution/device permissions, real Codex execution, integrated-provider text/voice routing,
  concurrent cancellation and durable confirmation state require their own host/device acceptance.

Add a new live test by registering its layer, prerequisites, bounded timeout and exact scope in the
catalogue. Prefer a declarative text case over a new runner when existing routing/continuation seams
cover the behavior. Keep public fixtures synthetic and generic; company-pilot cases belong only on
an internal branch.

## September 11 investigation

See [root-cause review](2026-09-11-live-findings.md) before interpreting the initial scores. The
Qwen null-argument delta incompatibility is fixed and pinned to a captured SSE replay. Knowledge
continuation fixtures now match a real in-process MCP handoff in an offline contract test. The
scorer now accepts reviewed equivalent constraint phrases and rejects unsupported years and known
false-execution claims. Original policy-probe wording remains unchanged: common-knowledge search,
"not decided" versus deferral, and disabled-capability recall need policy interpretation; a strict
case failure is not by itself a model-capability verdict. Diagnostic explicit-wording experiments
were not substituted for the original acceptance questions. Production frontend prompts were not
changed as part of this investigation.
