# v0.3 continuation implementation / 续作台账

2026-09-21: main worktree, `v0.3.0dev` at `ad1c87a6`. Existing changes, documents, images and experiments are retained. The memory implementation task explicitly released writes and `runtime/dist` after its modular acceptance. No commits, pushes, releases or real-user mutations are authorized here.

## Smallest complete slices

1. Preserve Life kind/status/date in memory and chat retrieval; exclude completed/cancelled/archived objects from discovery and invalidate old reminders on revision changes. Reuse the current Life state machine and feed lifecycle.
2. Resolve cross-turn personal candidates against authorized existing objects; explicit reschedule/completion/cancellation updates the same ID with CAS. Keep current-source judgment separate from old-object processing consent. Ambiguous updates must not create replacement objects.
3. Explicit news-to-idea/goal/todo conversion with durable provenance and retry deduplication; public excerpts remain source data, never user facts or execution permission.
4. Complete connector/client lifecycle gaps, beginning with independent Feishu model-processing consent. IM text entry requires an explicit identity/channel boundary and a read-only execution surface; existing model-provider consent does not authorize outbound IM.
5. Run isolated acceptance bottom-up through mechanisms, modules, cross-module chains and complete user workflows. Directory-size coverage is supplementary. Reuse `MEMORY-LIVE-ACCEPTANCE.md` modules. Account changes, physical voice, human-labelled JEV quality and releases are separate gates. M9 stays in v0.4.

Builds and every consumer of `runtime/dist` are serialized by the coordinating task. Subtasks may edit disjoint files; they do not rebuild. Each slice records the actual failing reproduction, fix and executed checks below; prior test counts are not new evidence.

## Read-only findings

- Life is already stored through the substrate merge/Markdown backend. `memoryReadContext` already preserves Life status/date; it needs no replacement.
- `SubstrateMemoryResource.#entry` currently maps Life kinds to `fact`, losing lifecycle/date in explicit recall and discovery. Host eligibility only understands commitment completion.
- Understanding currently creates objects only; its candidate contract has no update target/date. News has reading/saving but no conversion.
- Feishu runtime has `feishu.consent`, while desktop settings omit it. Mail/IM providers already have synchronization/lifecycle implementations; their real-account acceptance remains incomplete.
- User authorized local folder structure snapshots for acceptance. Initial metadata-only inspection of repository `docs` counted 721 files and depth 12, including old build/test artifacts; this is not source-ingestion acceptance or authorization to send private file contents to a model.

## Execution evidence

- Implemented typed Life recall/discovery metadata, date ordering and terminal-state exclusion; cross-turn identity resolution uses the authorized substrate extraction provider and fences every supplied old object, including unselected and NOOP contexts. Local-only legacy creates remain supported; unresolved updates fail closed.
- News conversion validates the current cache hash at command and mutation admission, preserves public provenance, and deduplicates through persisted article identity. Generic Life commands cannot manufacture a news source. Review reproduced a request-ID collision; conversion now reuses the normal ID generator.
- Feishu scope selection grants local reading only. Model-processing consent has an independent setting and provider/scope revalidation. Scope-change failure retains a paused state; revocation is not an atomic multi-source transaction.
- Initial focused suite: 86/88 passed; two existing local-host capture cases exposed an over-strict resolver hookup. Fixed and the affected 11-test group passed. Desktop component group: 45/45; live-runner contract: 11/11. Final broad checks are recorded below when complete.
- Life runtime live first exposed missing canonical Life evidence (the resource accepted only two evidence-ID sub-prefixes). Fixed at the common own-namespace read gate while retaining source, retention and recipient checks. `life-objects` and visible `life-desktop` both passed in `/tmp/nova-life-local-final.json`; desktop captures were inspected. Earlier hidden-window captures were blank and are not visual evidence.
- Directory metadata snapshot: 723 files, 17 symlinks skipped, 276 eligible text-shaped files, depth 11. Bodies were replaced with synthetic text and anonymous filenames. Real scanner/Knowledge Worker checks passed at 1, 10 and 100 files, including modification, deletion and restart; depth-16/17 and byte-budget checks passed. **276-file ingestion failed at the existing hard 100-source Knowledge limit** (100 indexed, 176 failed). This is a capacity failure, not a full large-directory pass. `/tmp/nova-directory-snapshot-private.json` retains the result. Initial harness-only failures from non-private temporary parent permissions are also retained.
- Real-model synthetic acceptance first exposed a record/update output-schema mismatch, then an omitted `decisions` wrapper in the resolution prompt, and finally historical-context quotes instead of the current source. These are fixed in the contracts/prompts, with failed artifacts retained; the final sequence result is recorded below. No rejected model output was admitted.

## Acceptance boundary

No source commits, pushes, releases, real account changes or real-user corpus writes. Local directory metadata never leaves the machine; model inputs are synthetic. Physical microphone/speaker, installed release binaries, actual Feishu/Apple accounts, outbound IM and human-labelled JEV quality remain unaccepted. The current directory Knowledge limit is 100 sources across its store, not 100 per folder.

## Final verification, current source

- Runtime build passed; changed-source ESLint and `git diff --check` passed.
- Full runtime: **2816 tests, 2807 passed, 8 skipped, 1 failed** in `/tmp/nova-continuation-runtime-full.log`. The failure was `desktop-tasks` native opener fixture startup. Its unchanged file passed **11/11** in isolation (`/tmp/nova-native-opener-rerun.log`). Do not call the original full run green.
- Real model: `/tmp/nova-life-model-current-source.json` passed. Seven evaluated turns, twelve extraction/resolution model calls, actual JEV decisions, eight recorded acceptance checks. Creates, paraphrase NOOP, date update, completion, cancellation, canonical evidence, complete resource restart and no implicit reopen all passed. This proves the bounded synthetic sequence, not general language reliability.
- Desktop full source test collection: **960 tests, 954 passed, 3 skipped, 3 failed** (`/tmp/nova-continuation-desktop-full.log`). Two native Swift tests failed to compile with the installed SDK (`SwiftBridging` redefinition / Foundation import failure). The third assumed an unhoisted Electron path; fixed to resolve the installed Electron package, then its native addon test passed in isolation (`/tmp/nova-native-addon-rerun.log`). Full desktop build/package acceptance is not claimed.
- Final compiled-source local modules `life-objects` and `life-desktop`: **2/2 passed**, `/tmp/nova-life-final.json`. Visible screenshots were inspected, including the reopened card's public source, date and completed state. Live catalog contract checks passed **11/11**.
- Model stability rerun: `/tmp/nova-life-model-repeat.json` passed **2/2** complete seven-turn sequences. Together with the preceding pass, the final contract passed three consecutive complete sequences. The model and local/Electron reports share runtime hash `798744ec63d06d38f4481ab54eeb55f96c5f28fd5d3ee7d0d4d8a955dcffabed`.
- Final visual evidence: `/tmp/nova-life-final.json.life-desktop-1.json.reopened.png`. It visibly retains the public source, `2026-10-03` due date and completed status after reopening.

## Bottom-up system acceptance (2026-09-21 follow-up)

The requested ordering is architectural: mechanisms → modules → chains → whole workflow. Corpus size is a separate capacity check.

| Layer | Evidence and boundary |
|---|---|
| Mechanisms | Existing storage/purge/recovery/consent modules; new failure/retry regressions for conversation pending state and text/voice initialization. Three exact failures were reproduced before fixing owner-scoped cleanup. |
| Modules | `life-objects`, `life-desktop` and `personal-understanding` retain their independent scopes above; the model module has a stub conversational reply and the desktop module forbids real model calls. |
| Cross-module chain | New `system-life` runs the source renderer over authenticated WebSocket/DesktopRealtime into the production conversation runtime and real Qwen conversation model, Understanding and JEV, with isolated SQLite/Markdown/Git persistence. Real provider events and tool results are observed without substituting answers. |
| Whole workflow | UI records a dated todo → fresh conversation recalls it → duplicate transport receipt is idempotent → UI corrects its date and marks it done → reminder excludes it → a separate Electron process opens the same temporary store → a fresh UI conversation recalls the corrected date and status. Parent/child PIDs and durable message pairing are checked. |

Live testing caught a model presentation bug: an otherwise correct date-only deadline acquired the evidence observation's time of day. The first loose-assertion pass (`/tmp/nova-system-life-traced2.json`) does **not** establish date precision. A stronger negative check caught recurrence even after prompt-only correction (`/tmp/nova-system-life-final.json`, one pass / one fail). The retrieval projection now states `due_precision: date` and `due_time: null` alongside the unchanged authoritative date; both prompt languages distinguish current Life state from historical evidence and record timestamps. Raw evidence timestamps remain intact. This is an explicit model input contract, not a deterministic guarantee about arbitrary generated language.

The harness selects Qwen with the configured DashScope key because this machine's default DeepSeek conversation provider has no key; saved settings are unchanged. External executor capabilities are disabled. Observed recall uses the degraded lexical fallback; this system fixture does not establish vector quality, physical audio, real accounts, installed-release behavior, or arbitrary-input model reliability.

Claude CLI `claude-fable-5-1` supplied a source review and a separate source-free design discussion. The review's lifecycle findings were reproduced locally before changes. A second full-source review upload was rejected by automatic approval; that payload was not sent, and the approved replacement contained only a generic design question and synthetic dates. Speculative review comments were not treated as defects without evidence.

The Swift gate remains environmental: the installed CommandLineTools SDK has duplicate SwiftBridging module definitions, and `/Applications/Xcode.app` points to an unavailable external-volume installation. A per-process Xcode override also failed; no toolchain or global settings were changed.

Final integrated result: `/tmp/nova-system-life-precision.json` passed **2/2** fresh synthetic workflows, including independent Electron process restarts and date-only negative checks. Runtime hash: `ac5f376e1664ebc7d7b868f6297c929a3742db3c13fbd90504cdca3047897fa0`. First restart screenshot was visually inspected. Focused regression: **20/20**; runner contracts: **13/13**; build, changed-source ESLint and diff checks passed. These focused results supplement, rather than relabel, the earlier full-suite failures.

Same-build lower-layer rerun: `life-objects` and `life-desktop` passed **2/2** in `/tmp/nova-life-layer-final.json`; its runtime hash matches the two integrated workflows above. No source commit, push, release or real-user data mutation was performed.

## Product requirement: broad personal-context coverage (2026-09-21)

**Required before claiming broad personal understanding; bounded project sampling is implemented, full coverage and semantic quality acceptance remain open.** A profile derived mainly from the active repository and its acceptance notes does not represent the user's wider context. Production discovery must cover diverse user-authorized sources: project roots, documents and notes, research collections, creative/media project metadata, downloads, and connected external volumes. Reuse the local-source and consent mechanisms; metadata discovery and bounded content processing must retain their separate permissions and coverage reports.

- Select evidence across source roots and meaningful topic groups. File counts, generated output, duplicated repositories, worktrees and backups must not silently determine personal-interest weights. Topic interpretation belongs to semantic understanding, not keyword-based authority. Breadth does not require inventing interests or forcing equal topic weights.
- Allocate discovery effort by logical project or collection, rather than individual file count. Treat a Git project as one initial unit: establish its purpose, structure and state from representative documentation and relevant change evidence, then cover other units. Deepen inspection when the user's task requires it, material uncertainty remains, or conflicting evidence needs resolution; stop repetitive reading that adds no useful information. A monorepo may contain distinct projects, while clones/worktrees may represent the same project; retain their context instead of blindly counting directories or merging distinct work. Apply the same principle to a note vault, paper library or creative project without Git.
- Keep active work, historical experience, third-party reference material and personal logistics distinguishable, with source evidence and uncertainty. A checkout does not prove authorship; a file modification time does not prove recent interest; an old unchecked task does not become a current commitment.
- Make inspected, sampled, skipped, inaccessible and truncated coverage visible. Mounted-volume loss and permission failures must remain visible gaps. Revocation, exclusion and processing consent continue to apply across all discovered roots.
- Produce profile, project and interest candidates with provenance. Recommend feeds across evidenced interests within the OS-selected language: native Chinese RSS for a Chinese preferred system language, English RSS otherwise. Domain diversity alone does not establish recommendation relevance. Let users correct priorities without treating source volume as preference strength.

Release acceptance must include: (1) one large repository alongside small, unrelated but substantive collections, with those collections still represented; (2) duplicate/worktree/archive amplification without inflated interests or project counts; (3) old personal notes and upstream READMEs without false current tasks or authorship; (4) unavailable/remounted volumes and revoked scopes; (5) bounded sampling with honestly reported omissions; (6) profile corrections and diverse feed relevance evaluated separately from successful ingestion; and (7) adding many redundant files to one repository must not consume the discovery budget at the expense of other projects, while a task requiring detailed inspection must still receive adequate depth. Real private examples stay outside public docs and fixtures. The existing 100-source Knowledge ceiling is a capacity constraint to resolve or explicitly expose, not evidence of broad coverage.

### Implemented foundation (2026-09-22)

Local Claude CLI `claude-fable-5-1` reviewed the design before implementation. Local directory discovery now detects Git/worktree markers, interleaves project/collection reads, caps a Git overview at eight representatives, prioritizes root over nested overview documents, skips generated dependency/code artifacts, and bounds project metadata traversal at 2,000 entries within the existing 20,000-entry root ceiling. Incomplete traversals do not infer deletion. Changed versions outside the selected budget lose authority. Content observations retain uncertain authorship/commitment; unchanged content does not acquire new identity from a touched modification timestamp. Snapshot deduplication does not delete independent provenance.

Desktop startup passes the OS-preferred language separately from UI language through runtime configuration to NewsService. Current-language sources alone feed fetching, ranking, visible articles, pending counts and conversion. Saved articles from the previous language remain durable but hidden until switching back. Source failure never enables a different-language fallback. Headless launches can set `NOVA_AUDIO_AGENT_NEWS_LANGUAGE=zh-CN` or `en`; default is English.

This is bounded sampling, not full-disk inference or automatic task-directed deepening. Non-Git collections retain the root-level body budget; cross-grant capacity scheduling, semantic clone/monorepo interpretation, broad recommendation relevance and inferred profile accuracy remain open. Private live inventories and model discussions are kept outside the public tree.
