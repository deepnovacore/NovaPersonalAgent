# Non-thinking frontend model comparison — 2026-09-17

## Method

Same production frontend instructions, tools and 12 synthetic scenarios, five repetitions each: **60 cases/model, 300 cases, 361 HTTP turns**. Models ran one request each concurrently, with shared case/repetition order. Qwen used DashScope; DeepSeek used its official endpoint. Qwen requests explicitly set `enable_thinking=false`; DeepSeek used `thinking: {type: "disabled"}`. All requests had zero reasoning output and no HTTP, network or protocol failures after the stream parser fix. No returned tools were executed.

DeepSeek in this comparison is **V4.1 Flash (`deepseek-flash`)**, as requested, not V4 Pro. Provider mapping: [official model documentation](https://api-docs.deepseek.com/quick_start/pricing/).

## Results

| Model | First text P50 | First tool fragment P50 | Usable result P50 / P95 | Passed | Unexpected mutation cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| qwen3.8-max | 0.657 s | 0.882 s | 1.633 / 3.337 s | 52/60 (86.7%) | 8 |
| qwen-plus | 0.540 s | 0.977 s | 1.283 / 2.279 s | 36/60 (60.0%) | 0 |
| qwen-flash | 0.387 s | 0.499 s | 0.708 / 1.289 s | 43/60 (71.7%) | 0 |
| qwen3.8-flash | 0.654 s | 0.726 s | 1.334 / 3.695 s | 55/60 (91.7%) | 4 |
| deepseek-flash | 0.708 s | 0.789 s | 1.094 / 1.996 s | 54/60 (90.0%) | 5 |

First text excludes tool-only responses and measures a nonempty content delta, not an SSE heartbeat. Usable result measures the first text or complete tool call actually emitted by the production adapter. Tool-enabled text is buffered until the response kind is known. These numbers exclude ASR, coordinator, executor and TTS; they are not mouth-to-ear latency. Input/output lengths differ by scenario and model.

## Case results (out of five)

| Case | Max 3.8 | Plus | Flash | Flash 3.8 | DeepSeek Flash |
| --- | ---: | ---: | ---: | ---: | ---: |
| greeting | 5 | 5 | 5 | 5 | 5 |
| coding | 5 | 4 | 0 | 5 | 5 |
| coding-steer | 5 | 0 | 0 | 5 | 5 |
| coding-cancel | 5 | 5 | 5 | 5 | 5 |
| confirm-yes | 5 | 1 | 3 | 5 | 5 |
| confirm-no | 5 | 0 | 0 | 5 | 5 |
| confirm-ambiguous | 5 | 5 | 5 | 5 | 5 |
| confirm-question | 2 | 5 | 5 | 5 | 5 |
| coding-discussion | 5 | 5 | 5 | 5 | 5 |
| coding-clarify-before-dispatch | 0 | 0 | 5 | 2 | 0 |
| coding-clarification-still-unresolved | 5 | 5 | 5 | 5 | 5 |
| weekly-report-after-clarification | 5 | 1 | 5 | 3 | 4 |

## Failure audit

- Qwen 3.8 Max: all five vague Snake requests dispatched before clarification; three undecided confirmation questions became `confirm(accepted=false)`. This was mistaken rejection, not approval.
- Qwen Plus: mostly verbal acknowledgement without the required function call, including updates and confirmation/rejection; clarified requests often remained undispatched.
- Qwen Flash: fastest, but over-clarified executable requests and omitted update/rejection calls; explicit confirmation passed only 3/5.
- Qwen 3.8 Flash: three premature Snake dispatches, one premature weekly-report dispatch, one additional clarification instead of expected dispatch.
- DeepSeek Flash: all five vague Snake requests dispatched before clarification, sometimes explicitly delegating the unresolved platform choice to the executor. One weekly-report case continued asking instead of dispatching.
- DeepSeek raw score was 51/60. Manual review corrected three `coding-steer` synonym false negatives (repeats 0, 2, 4): each explicitly retained style-only changes and unchanged business logic. Audited score 54/60. Original observations/status/failures are retained in the private audit artifact. No failed live request was dropped or silently retried.

These are fixed-suite contract pass rates, not coding completion or general reliability estimates. Some additional-clarification failures reflect a strict fixture expectation; premature dispatch and mistaken rejection are separately counted. None passes every required clarification/confirmation scenario. Five repeats are not enough to establish a small ranking difference such as 55/60 versus 54/60.

## Shared parser root fix and validation

DeepSeek exposed a real shared streaming bug: `next.set(read.value)` overwrote an unfinished buffered SSE line instead of appending at `buffered.length`. Complete raw SSE replay passed while live fragmented input corrupted otherwise valid JSON. The fix is `next.set(read.value, buffered.length)`, with no text-to-tool repair or intent heuristic.

Regression covers one-byte, seven-byte, 31-byte and full-buffer chunks, including UTF-8 splits. A pre-fix reproduction fails with protocol error; corrected parser passes. Runtime build and 86 Qwen/DeepSeek parser, cascaded adapter and provider-session tests passed. All five models were then rerun from scratch for the table above. Earlier Qwen results and failed DeepSeek baseline remain available separately and are not pooled into this table.

## Reproduce and evidence

```sh
npm --prefix runtime run build
node runtime/scripts/live/frontend-model-comparison.mjs \
  --models qwen3.8-max,qwen-plus,qwen-flash,qwen3.8-flash,deepseek-flash \
  --repeats 5 --output /tmp/frontend-comparison.json
```

Credentials are read from .env/process environment and never recorded. Private evidence: `.data/diagnostics/2026-09-17-model-comparison/all-after-stream-fix{,-audited,-summary}.json`. The selected frontend model was not changed and the running desktop was not restarted. This is a live frontend API comparison, not physical microphone/speaker acceptance.
