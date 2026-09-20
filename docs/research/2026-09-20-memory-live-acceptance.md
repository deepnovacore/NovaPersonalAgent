# Memory live acceptance — 2026-09-20

Scope: synthetic facts only, real configured model and embedding services, separate temporary databases. Existing email/calendar processing consent was not enabled. No real connector content was sent to models.

## Reproducible backend verification

After building runtime, run with configured credentials (never print them):

```sh
node --env-file=/absolute/path/to/.env runtime/scripts/live/memory-substrate.mjs
node --env-file=/absolute/path/to/.env runtime/scripts/live/memory-substrate.mjs --production
```

Both runs passed: no extraction before consent; real Qwen extraction; real text-embedding-v4 vector search with degraded=false; source text lookup; real model answer carrying the exact returned evidence ID; persistence after close/reopen; source deletion removes both retrieval hits and readable evidence. Each database contained one extraction and two stored vectors before deletion. The production run uses the actual composition with DeepSeek selected for conversation, exercising the provider boundary that failed in the desktop run. The script retains only its synthetic database and result.json in an OS temporary directory.

## Defects found through desktop acceptance

1. Selecting DeepSeek for conversation hid the DashScope credential needed by local memory. Runtime configuration and desktop saved-secret injection now consider local memory independently. Both added regressions failed before the fix; configuration/backend suite: 103 passed.
2. Local memory reused the conversation support gateway while requesting its separately configured extraction model. With DeepSeek conversation and Qwen extraction, evidence was stored but no extraction or vectors committed. Local memory now constructs its gateway from its configured endpoint/credential, matching the extraction model configuration. Knowledge-only composition retains its existing gateway.

## Packaged desktop result

Used an isolated Nova profile with no connector accounts. Entered a synthetic project fact and marker through the normal chat UI. Before the second fix, the assistant acknowledged it, but a new conversation returned no memory and the memory page was empty; after graceful process shutdown the database held three evidence records, zero extractions and zero vectors. A preliminary computer-input attempt submitted only the marker digits; it was not counted as successful fact admission.

After the gateway fix, restarted the same isolated profile without re-entering the original fact. In a new conversation the assistant correctly recalled the full synthetic marker and attributed it to the earlier user's original statement. The memory page displayed two extracted facts (project responsibility and acceptance marker), both labeled as user-stated. This verifies recovery of pending evidence, actual UI visibility, and retrieval across restart/conversation boundaries. Desktop visual evidence did not expose a canonical evidence-ID link; exact evidence-ID validation and deletion invalidation were checked by the live backend script.

## Validation limits

- Runtime build passed; configuration/resource regression run: 50 passed. Backend suite was also included in the separate 103-pass run. JavaScript syntax and diff whitespace checks passed.
- The full desktop build failed in Swift compilation because the configured external Xcode path is unavailable and the remaining CommandLineTools SDK reports SwiftBridging module redefinition. The local test package reused unchanged native helpers after SHA-256 comparison against the prior package, then staged the rebuilt JS/TS runtime and packaged successfully. This is not a clean native rebuild or release signing/notarization acceptance.
- Real microphone/voice recall, real private connector model processing, complete native Mail 500-candidate scans, and the previously failing broad runtime startup-timing tests are not declared passed by this work.
