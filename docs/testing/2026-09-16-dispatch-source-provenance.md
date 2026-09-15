# Cascaded dispatch provenance acceptance — 2026-09-16

## Root cause and change

The reported desktop failure occurred at host dispatch admission, before Codex started. The original telemetry recorded rejection without its code; it cannot establish the historical rejection reason by itself. A production-pipeline replay of the same two user transcripts reproduced `invalid_source_quotes`.

Two defects made the old quote contract fragile:

- Admission reused playback recovery pairs. An interrupted assistant reply removed the preceding genuine user message from that projection, even though it remained valid task evidence.
- The frontend transcribed user evidence into `source_quotes`, sometimes rewriting “写一个俄罗斯方。” into a polished game request. Strict original-text validation correctly refused the rewritten quote.

Supplying corrected quotes in the error response did not solve the contract: one fault probe repeated invalid quotes 33 times. That attempted repair was removed. The public dispatch tool now accepts structured `source_refs`; the host resolves those references against retained original user records and supplies the internal coordinator evidence. Unknown references and the obsolete quote parameter are rejected. Admission telemetry includes the rejection code.

The displayed reference directory is bounded independently from validation. Playback completion does not determine reference validity. Context revisions belong to the composition owner; shared provider-session handling removes the directory from host-fact narration. Preferences retain their existing size budget. This adds no keyword intent routing, fuzzy quote matching, retry counter, or automatic execution retry. Frontend dispatch/confirm/cancel and downstream workspace/session ownership remain unchanged.

## Model choice

Qwen Flash still dispatched an ambiguous request early in some same-code probes. These are failed clarification results, not accepted runs. Qwen Plus twice clarified before dispatch in the production replay, and corrected an injected unknown reference after one rejection. The user selected clarification reliability over latency: the Qwen frontend default is now `qwen-plus`; existing explicit model selections remain supported. The local desktop profile was also changed to Plus and verified, without restarting the client. Surrogate/compressor defaults are unchanged.

These observations do not prove that any model always clarifies correctly. The structured host protocol enforces provenance and authority, not semantic completeness through keyword rules.

## Verification

| Check | Observed result |
| --- | --- |
| Runtime suite after protocol/lifecycle changes | 2,367 passed, 8 skipped, 0 failed |
| Final config/assembly regression after default-model update | 113 passed |
| Desktop settings/backend regression | 111 passed |
| Live runner contract tests | 9 passed |
| Runtime build and lint; desktop build | Passed |
| Same-input production replay with Plus | Clarification first, then `intake_opened` |
| Injected unknown source ref with Plus | One `invalid_source_refs`, then `intake_opened`; no empty retry promise |
| Official cascaded clarification/failure live check | Passed; receipt silent, concrete question, failure states task did not start without requesting reconfirmation |
| Real Codex: create workspace, confirm, write/read | `acceptance.txt` = `NOVA_E2E_OK` |
| Real Codex: continue in same session | `continued.txt` = `CONTINUE_OK`; same thread verified |
| Real Codex: explicit new session | `new-session.txt` = `NEW_SESSION_OK`; different thread verified |

All three files were independently read back after the live runner completed. Executor tests used isolated temporary workspaces and the existing shared Codex account. Their success does not imply the physical microphone, speaker, or desktop UI were accepted. The clarification/failure runner uses real model calls with synthetic host facts; it is separate from actual executor execution.

Local Claude CLI with `claude-fable-5-1` reviewed the implementation and lifecycle corrections. Raw probes, failures, model outputs, and review evidence are retained locally under ignored `.data/diagnostics/2026-09-16-dispatch/`, not published with credentials or personal conversations.

Remaining product polish: the successful executor run still sometimes said “收到宿主反馈” and gave verbose completion wording. Execution, provenance, and the tested failure behavior passed; fully natural narration and physical voice interaction are not claimed complete by this report.
