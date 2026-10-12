# Source sync and incremental Profile acceptance

Date: 2026-10-11. Branch: `feature/source-sync-incremental-profile`, based on `89804c57`.
The implementation is an uncommitted working-tree change; nothing was pushed or deployed.
Source and bilingual documentation diff SHA-256 (excluding this report):
`6060deea8f53cb1106e82bf1eb532c5f3c022abb4d6b72d832717b614e299433`.

## Changes verified

- Feishu: four chat workers, newest-first new windows, separate historical/live cursors, fair per-chat budgets, durable page admission, and one context refresh per page. Legacy state and unfinished ascending page tokens remain compatible.
- Composio: four concurrent connections across automatic and manual sync; Gmail fetches four bodies concurrently while retaining request budgets and safe failed-batch replay.
- Profile: cumulative five-minute, thirty-minute and four-hour snapshots while scanning continues; later changed-input snapshots at least four hours apart. Restart preserves the schedule. Eligible prior facts survive bounded sampling, while withdrawn or edited raw evidence is pruned. Message A→B→A restores the current version.
- Own IM and verified SENT Gmail evidence enter Profile only with processing consent. Authorization is checked before and after model generation. Native mail/calendar are not directly treated as self-authored Profile inputs.

## Automated checks

| Check | Result |
|---|---|
| Runtime TypeScript | Passed |
| ESLint for changed runtime files and tests | Passed |
| Complete affected test files | 118 passed, zero failed |
| Low-concurrency recheck of Life resolution, memory purge and resolution fences | 17 passed, zero failed |
| CLI tests with loopback access | 30 passed |
| Server CLI tests | 4 passed |
| Diff whitespace check | Passed |
| Independent review | Current-version and shared-concurrency fixes reviewed; no remaining finding |

The broad runtime run was not green: 3,392 passed, 11 failed, one cancelled and eight skipped. Its Life/purge/resolution failures passed the later 17-test recheck. Mem0 failures and the locked-worker cancellation were not independently resolved, so this is not a full-suite pass. Desktop build could not proceed because `app-builder-lib/out/toolsets/icons.js` was unavailable. Packaged desktop/UI acceptance is therefore unverified.

## Live checks

Real-channel reads used copied Feishu credentials and isolated temporary state, with zero model calls. Original source configuration and Profile were not changed. This checks the actual API/native readers without sending real content to a model.

| Channel | Observation |
|---|---|
| Feishu | One descending page, 17 text messages, about 1.46 seconds; eight self-authored Profile inputs selected |
| Native macOS Mail | Access granted; four objects read in about 13.44 seconds; continuation present |
| Native macOS Calendar | Access granted; selected window read successfully, zero events, about 0.15 seconds |

The model live run used only literal synthetic messages and two synthetic Markdown files in an isolated directory, through the production `PersonalAgentHost`, real ledger/index, and configured `qwen3-vl-plus` gateway:

- New synthetic messages arrived every ten seconds. The first automatic Profile completed at 316,484 ms after its persisted anchor, with 32 batches admitted and one model call.
- Two synthetic files were parsed/indexed. An explicitly requested second model snapshot cited those files. Total model calls: two.
- On reopening the isolated runtime, the persisted snapshot still cited files. Withdrawing the synthetic IM grant removed all IM facts while retaining authorized file facts.
- Reference count is bounded and may decrease between snapshots; acceptance checks actual file citations rather than monotonic count growth.

Thirty-minute/four-hour cadence and unchanged-input stages were verified using virtual clocks, not by waiting four hours. The second live model snapshot was manual. Gmail had no live connection in this environment and was verified with provider fixtures. Native mail body collection still uses the existing native reader and showed the latency above.

Initial automatic approval review rejected sending real Feishu or repository content without explicit destination/content authorization. The user subsequently authorized at most eight recent self-authored Feishu messages to the configured DashScope `qwen3-vl-plus`, with the original Profile unchanged. That limited real-person acceptance is completed below. No real message content, account identifiers or credentials are included in this report.

## Follow-up: paired timing and authorized personal-message acceptance

The earlier single-page timing measured API reading only. This comparison includes scanning, local evidence admission, and context refresh. Old (`HEAD`) and new Feishu connectors each ran three times in an interleaved order, on one selected chat and a fixed seven-day window, using the same current ledger/Host implementation with model extraction disabled. All six runs admitted the same 17 evidence IDs and content fingerprints. This isolates connector behavior and refresh granularity; it is not a comparison of two complete packaged desktop builds.

| Scanner component | Before (ms) | After (ms) |
|---|---|---|
| Run 1 | 6746 | 2754 |
| Run 2 | 6747 | 2631 |
| Run 3 | 6614 | 2560 |
| Median | 6746 | 2631 |
| Context refreshes per scan | 17 | 1 |

Median elapsed time fell by 61.0% (2.56 times the throughput in this small single-page case). The message-list API itself remained around 1.0–1.3 seconds; this does not show an API/network speedup or prove throughput on multiple large live chats.

The authorized model run supplied only eight newest self-authored messages, admitted to an isolated ledger. No other speaker, mail, repository file or original Profile was sent. The first long-reference request reached the 60-second Profile timeout. A compact-reference change now supplies call-local `e0/e1` IDs and numeric version 1; the adapter rejects unknown IDs/wrong versions and restores the exact original evidence IDs/versions before host authorization checks and persistence. This reuses the short-key approach already used by the context writer.

On the same eight saved inputs, the compact run returned in 15,220 ms; the full manual generation operation took 16,300 ms. It generated 13 grounded Profile items (six work items, six interests and an overview), with all references checked against the original admitted ID/version pairs. Original Feishu configuration and original Profile hashes remained unchanged. This is one model comparison against a timeout, not a statistical latency benchmark or a guaranteed fourfold speedup. No generated personal content is reproduced here.

Additional validation: 46 writer/warmup tests passed, then 90 writer/warmup/source/host caller tests passed; TypeScript, changed-file ESLint and whitespace checks passed. Independent review found no new compact-reference security or compatibility issue. The initial 118-test affected suite remains the evidence for the earlier connector/substrate changes.

At the time of this earlier measurement, the shared per-message extraction queue still serialized model calls. The later four-way queue change is separately tested; this earlier timing did not measure its complete backlog. Profile now consumes authorized own-message evidence directly and can generate without waiting for that backlog. The running desktop application has not been switched to this branch, and no commit, push or deployment was made.

## Follow-up: concurrency, batching and index complexity

The shared model queue, Feishu chats, shared mention-detail reads, Composio connections, Gmail bodies, local folder sources and scan-time knowledge ingestion now each have a four-worker bound. Each local source retains its own recovery checkpoint; its file commits remain ordered. The single SQLite worker still serializes atomic commits. Repeated polls are coalesced; cancellation drains the affected source. Removing an old file also fences an in-flight replacement with a fresh ID.

A Feishu text page now uses one atomic evidence batch and applies each source grant once. Existing message heads preserve edits, including A-to-B-to-A replay. A wholly unchanged page skips Host context refresh, but an authorization change still triggers it. Failed page transactions roll back all rows. The one-minute overlapping live window remains intentional to reconcile recent changes; it is not a permanent history restart. Mention detail lookups for other speakers share four request slots, preserve page order, and drain on error; self-authored messages avoid them.

Tracked-file lookup is now a scan-local Map rather than repeatedly searching the tracked array. Knowledge lookup uses an SQLite locator index. syncFile returns its committed fingerprint, removing a whole-index readback per file. Recovery still reads the committed index separately.

### Current local live comparison (three pairs, synthetic content only)

These runs use real filesystem reads, document parsing, SQLite stores and persisted source checkpoints. No external model or private file text was used. File baselines load sources.ts and knowledge/service.ts from base 89804c57 with the current common store. Message rows compare per-message admission against a single batch using the current resource; they are not a whole-revision or API speed comparison.

| Work | Before median | After median | Observed change |
|---|---:|---:|---|
| 50 messages admitted | 2298 ms | 91 ms | 96.0% less elapsed time; 102 ledger calls to 4 |
| 48 files in four folders | 1788 ms | 1624 ms | 9.2% less elapsed time; ingestion peak 1 to 4 |
| Full knowledge-index listings during that file scan | 148 | 4 | 97.3% fewer full-index listings; 96 indexed locator lookups instead |

All 48 files were indexed in every run; all four checkpoints were cleared. Repeating the same message batch returned unchanged in all six admission runs. Small Markdown files mostly exercise durable writes, so four readers do not imply fourfold wall-clock speedup.

### Checks and the earlier live limitation

- The five affected test files completed with 163 passes and no failures. The final boundary recheck completed with nine passes and no failures, including page rollback, grant-only change notification, four shared mention reads, four folder slots, crash recovery, pause and removal fencing.
- Runtime TypeScript and ESLint for the final changed files passed after restoring the declared mem0ai 3.2.0 dependency in a temporary directory; the project lockfile is unchanged.
- The earlier real-model backlog run used eight literal synthetic records: peak four simultaneous model calls, all eight completed, no pending extraction, 3967 ms processing time. This was not real-mail or real-message extraction.
- The first follow-up read-only Feishu scan could not proceed: the isolated CLI credential copy reports user status missing. The same user identifier was verified without logging it. Zero-message runs were rejected and are not performance evidence. The original state was unchanged. No new login, model submission, or original Profile write was performed.
- The earlier successful Feishu API measurement remains separate historical evidence. Neither it nor the local batching benchmark proves that upstream rate limiting never occurs; no claim of a newly verified API speedup is made.
- The running desktop application has not been switched to this branch. No commit, push or deployment was made.

## Credential recovery and follow-up Feishu live acceptance

The encrypted original user credential and master key were present and decrypted correctly. Offline CLI status reported needs_refresh. Online verification then returned that the refresh token had been revoked and could only be used once; the CLI deleted the rejected credential from the isolated copy, causing later status calls to report missing. This establishes a refresh failure, not absent original files or an API rate-limit response. The exact earlier refresh that consumed the token was not established.

The user completed a fresh OAuth authorization in the same application. Verified account identity, application binding and all required message scopes matched. The original encrypted files, configuration and source state were backed up and checked byte-for-byte before the verified user credential was atomically replaced. The original source state and Profile were not rewritten; the desktop app remains on its existing build.

Three successful read-only scans then fetched the same 14 messages in one previously selected chat, using a fixed seven-day window. Each ran with model processing disabled and its own ledger. No message detail requests were needed.

| Run | Scan elapsed | Message-list CLI call | Batch admission | Messages | CLI failures |
|---|---:|---:|---:|---:|---:|
| 1 | 2341 ms | 1256 ms | 34 ms | 14 | 0 |
| 2 | 2427 ms | 1559 ms | 45 ms | 14 | 0 |
| 3 | 2281 ms | 1233 ms | 41 ms | 14 | 0 |

All three unchanged replays returned false (no source-context refresh needed), and the original source state was unchanged. Scan elapsed includes the connector's authentication verification and admission, but excludes Host context/Profile generation. The CLI-call time includes process/CLI overhead and network, not just server latency. These successful calls showed no surfaced failure or rate-limit response; hidden provider/CLI retries were not instrumented. This is not a new whole-application before/after comparison, and the current 14-message window differs from the earlier 17-message sample.

## Capped all-chat history acceptance

A separate read-only audit enumerated 122 accessible chats and stopped at 10,000 unique provider message IDs. It admitted 6,927 text messages: 2,497 authored by the account, 157 directly mentioning it, and 4,273 other contextual messages. The scan took 105,286 ms, with 775 list calls, 180 detail requests and 6,976 ms of admission work. Summed concurrent request durations are not wall time. The remaining 3,073 provider records were not classified individually; they must not all be described as attachments or unsupported records.

The audit used an explicit one-history-page-per-chat-per-round override with four chat workers, rather than the production per-chat page budget. Thirteen chats still had history remaining when the cap was reached. Completed chats were queried again in later rounds, so this audit contains avoidable empty-window work; its timing is not a paired production before/after benchmark. Original source state and Profile remained unchanged.

Only the account-authored and directly mentioning texts (2,654 total) were authorized for external Profile generation and review. Other contextual messages stayed local. Every authorized model record included its original provider timestamp, self/addressed role, local thread alias and traceable message reference. Fifteen summary batches ran with four concurrent workers. The successful final DashScope aggregation took 34,926 ms after reusing completed summaries; this excludes earlier schema failures, batch generation and review, and is not an end-to-end generation measurement. Private messages and generated Profile content are excluded from this repository report.

The requested local Claude CLI review completed successfully using claude-sonnet-5-5 in 324,325 ms, with built-in tools and MCP disabled. It identified substantive attribution, stale-state, planned-versus-completed and reference errors in both the full draft and the eight-message baseline. Its proposed correction exceeded the application schema's item/reference limits, so it was not installed directly. A separate concise, locally edited Profile passed the production schema, and all its references resolved to authorized account-authored evidence. This is a reviewed acceptance artifact, not proof that the automatic production generator reliably produces the same quality.

The authorized historical text also contained suspected credential strings. Raw authorized messages were submitted without an input-redaction pass; no credential text is included in the repository report or final reviewed Profile. Input redaction remains an unresolved limitation of this audit harness. Existing desktop Profile and source configuration remain unchanged.

## 2026-10-12: equal-dataset scan comparison and attribution fixes

An isolated scan with the same cutoff and 10,000 unique provider-message cap returned exactly the same 6,927 message IDs, texts and timestamps as the previous scan. Both covered 122 chats; 13 chats still had unfinished history. Scan wall time decreased from 105,286 ms to 69,809 ms (33.7%), and message-list calls from 775 to 279 (64.0%); detail calls remained 180. This is one paired live measurement using a one-page-per-chat-per-round audit harness, while model generation was also running; it is neither a repeated benchmark nor a complete-history guarantee. Completed live cursors no longer repoll an unchanged frozen window.

Profile now carries message time, pseudonymous sender identity, available sender display name, direct-mention/recipient targets, and reply/thread/forward relationships through admission and projection. The CLI's `reply_to` alias is normalized to `parent_id`; available raw `root_id` and `upper_message_id` are retained. The CLI can omit raw relationships during formatting, so absence is not proof of no quotation. Links outside the authorized sample are explicitly marked, without fetching or sending unauthorized bodies. Replies identify context, not authorship of every sentence. Long duplicate forwarded bodies are compared after media-placeholder removal and normalized whitespace, respecting original-before-copy time order.

Generation uses bounded batches with four workers and an instance-local summary cache. Final claim verification requires attribution, support, modality and literal original-message quotes; message-derived claims omitted by a newer draft are not blindly resurrected. Shared screening now recognizes additional Chinese credential labels, formatted card numbers and standalone opaque token strings, while preserving ordinary paths and SHA256 fingerprints. These rules do not guarantee recognition of every unlabelled credential.

The v3 live generation did not pass: verification JSON was truncated at its output ceiling on both attempts. Its result is not an accepted automatic Profile. The next candidate increases the verification output budget and bounds quote counts and lengths. Before the final reply/thread alias adjustment, 135 affected tests passed; runtime TypeScript build and changed-source ESLint passed. Final validation and live review are recorded separately below when complete.

A read-only live GET of the two authorized messages in the duplicate-forward case returned `msg_type=post` and no parent/root/upper/thread IDs on either message. This concrete case therefore cannot be resolved by platform relationship metadata alone. Official CLI formatter source also shows `parent_id` renamed to `reply_to` when no `thread_id` exists; the connector now accepts that alias. No original sender identity or message text is included in this report.

Final relationship changes: TypeScript compilation into an isolated temporary output, 23 Feishu tests, one Profile metadata projection regression, ESLint and whitespace checks passed. The earlier 135-test affected run also passed.

The v4 cold full-history Profile run encountered DashScope HTTP 429 during summaries. Resuming reused 17 saved successful summary responses from the identical authorized input and completed in 170,757 ms; this is a resumed duration, not a cold-generation benchmark. Of 2,654 authorized own/direct-mention messages, screening redacted 18 and rejected 14. The model processed 2,639 messages after one long forwarded duplicate was excluded; no other-speaker context was supplied. The automatic result retained three work items and three interests; about was withheld by quote/attribution checks. A separate local Claude CLI `claude-sonnet-5-5` review completed in 31,005 ms and returned `passed=false`: it found overclaimed implementation ownership and work items with references that support only a subset of the text. Therefore schema-valid output is not a quality-acceptance pass. It also identified previously missed credential-only message formats; the already submitted calls cannot be retroactively sanitized. Additional screening now rejects opaque credential-only lines in multi-line blocks and standalone password-shaped strings, with a known risk of withholding benign code-like strings. No original Profile was overwritten.

## 2026-10-12: per-item grounding and fresh isolated acceptance

Subsequent automatic candidates failed independent review for pasted assistant answers, cross-message timeline/identifier claims, or failed the verification JSON contract. They were not accepted or installed. Verification now re-derives each item from only its own references, without seeing draft wording, with four workers, one fixed key per response, bounded clauses, literal quotes, local ownership/name/version checks and dated work clauses. Duplicate reviewer keys receive a bounded formatting retry. Screening works line by line and additionally masks Profile contact and machine addresses.

After restoring normal Feishu authorization, a fresh current-cutoff scan covered 122 accessible chats in 67,261 ms: 276 list calls, 180 detail calls, 6,954 text messages. The 10,000-provider-message stop threshold overshot to 10,038 due to in-flight concurrent pages; 13 chats remained unfinished. This is a bounded audit, not complete history or an equal-dataset comparison with earlier runs. The original source state remained byte-identical.

Only 2,658 own/direct-mention messages were eligible for external processing (2,499 own and 159 direct). Input screening rejected 114 and redacted 183, leaving 2,544 sanitized entries. Cold automatic generation, including two format retries, took 146,608 ms over 38 calls with maximum four concurrent requests. It produced an about section and six work items, and withheld interests. These counts do not prove semantic acceptance; the independent review is recorded below when complete. Original Profile and source state checksums remained unchanged.

Runtime compilation, 179 affected tests and changed-source ESLint passed. An isolated compilation plus all 23 Feishu tests passed after strengthening the restart/incremental-window regression: two successive new-message windows start at the persisted previous cutoff minus the one-minute boundary overlap, and completed historical scans do not restart. Previously persisted extraction completion receipts prevent duplicate evidence from rewriting a fact. This does not promise zero boundary rereads or a provider-wide edit/deletion stream. Desktop replacement, packaging and whole-suite acceptance were not performed.

The first per-item candidate received a 43,195 ms Sonnet review with `passed=true`, but the review text still noted an inferred nickname expansion and overly strong commitment wording. It is retained only as a comparison artifact. At the user's request, the final implementation removes keyword-based role/status guards, identifier/name matching and long-Q&A truncation. Per-item inputs now scope author metadata as well as message bodies to cited evidence; semantic attribution is handled by the model, while local checks retain schema, literal quote, authorization and privacy validation.

The simplified final candidate completed a fresh full model run in 242,047 ms, including one formatting-failure retry and its 20-second delay, with 57 model calls and maximum concurrency four. The same 2,544 sanitized own/direct entries were used; no other context was submitted. It retained about and six work items, without inferred interests. Final runtime build and 117 focused tests passed; these replace the earlier semantic-rule tests with a scoped-author regression. Final independent review is recorded separately.

Final independent local Claude CLI review used the requested `claude-sonnet-5-5`, completed in 59,322 ms and returned `passed=true` with no critical findings. It confirmed grounded roles, plans, quoted source details and privacy, while noting narrow coverage and one wiki absence statement that may be misleading outside its single-message scope. This is a factual/privacy acceptance of the automatic bounded Feishu Profile, not parity with Today.ai or proof of comprehensive long-term interests. No manual Profile correction or original Profile write was performed. Final changed-source/test ESLint and whitespace checks passed.

## Natural-language Profile revision

The dated audit prose was caused by two implementation choices: the reviewer described each message-time action, and the adapter prepended `YYYY-MM-DD` to every work clause. The adapter no longer inserts dates or first-person stripping rules. Generation and per-item review now request a coherent second-person about section and topical work paragraphs, keeping original timestamps in model evidence for state checks. Topic titles are produced by the scoped reviewer instead of truncating a full action sentence. Natural time references remain possible where they clarify changed plans. Exact reference validation, source authorization and redaction remain in place.

Runtime build, 94 writer/sensitivity/warmup tests, changed-file ESLint and whitespace checks passed. A regression verifies reviewed topic titles, prose without inserted evidence dates, and unchanged reference restoration. Live results are recorded below when complete.

The user clarified that ordinary context should remain intact by default. The shared product policy now preserves email, URL, IP/address and arbitrary code-like strings instead of Profile-specific masking or token-shape guessing. Explicit credential labels, recognizable private keys/tokens and credential-bearing URLs retain screening. Tests cover ordinary-context preservation and multiline labelled credentials. Earlier screening counts describe only the older live sample, not the new default policy.

Natural-language validation exposed a citation-shape limitation: a sentence synthesized from several messages could retain only one source ID. Review clauses now carry an array of directly supporting references, restoring all original IDs/versions. The scoped reviewer sees its own draft and cited evidence to correct subject and plan/completion errors while retaining natural wording. Model-copied literal quotes and the experimental quote-refinement retry were removed; provenance is represented by message references, without duplicated long quotations. Semantic grounding remains model-dependent. Failed intermediate candidates are not accepted.


## Natural-language Profile and final-prose verification

The user permits reasonable synthesis and elaboration: a Profile should explain work themes, collaboration and habits rather than reproduce dated actions. The acceptance standard allows grounded interpretation and does not require literal sentence matches. Concrete names, identities, attribution and planned/completed outcomes remain material checks. Earlier strict candidate failures are historical results under the previous standard, not proof that all interpretive prose is invalid.

The pipeline now organizes factual material, writes natural prose, then reviews the final text against cited originals with up to four workers. Corrections retain prose and original references; there is no unchecked rewrite afterwards. Selection summaries are used only to retrieve originals. Qwen3 VL Plus/Flash transports support explicit bounded thinking for these calls, without adding provider flags to generic or legacy model transports. The live harness now uses this production transport instead of an injected fetch experiment. Privacy defaults preserve ordinary context, screening explicit credentials only. No semantic keyword fallbacks were added.


## Whole-profile editing and transport follow-up

The scoped support/correction prototype leaked audit commentary into prose and allowed contradictory about/work states. Claude Sonnet 5.5 advised composing directly from selected originals, then editing the whole profile against original evidence. The final implementation follows that design: batch indexes select sources; large inputs rank up to 40 original messages; references are re-keyed contiguously; composition and whole-profile editing share one source set. Editorial notes are not rendered. Necessary earlier/later evidence can remain in the selected set. The user explicitly allows grounded interpretation, without invented concrete actions, actors, outcomes or named mechanisms.

The model payload now labels platform senders rather than claiming text authorship. Pasted assistant reports remain unverified body text and cannot automatically become the sender's personal execution accomplishments. This is provenance metadata and model reasoning, not a keyword-based semantic fallback.

Real Qwen thinking calls with JSON mode sometimes returned scalar numbers. The configured Qwen thinking adapter now omits that incompatible structure guarantee, leaving JSON/schema validation local; non-thinking Qwen requests retain JSON mode. This compatibility limit is documented by Alibaba Cloud: https://help.aliyun.com/en/model-studio/qwen-structured-output. The private harness now uses production defaults of 120 seconds per request and 180 seconds per generation. Earlier expanded private timeouts are not equivalent acceptance evidence.

The current default-policy sample has 2,658 authorized messages (2,499 account-authored, 159 directly mentioning); explicit-credential screening excludes 9 credential-only texts and partially screens 20, leaving 2,649 inputs (2,490 authored and 159 direct mentions). Ordinary names and work context remain. The initial cold prototype took 249,815 ms over 34 calls and 21 batches at peak four workers, with no summaries reused. The intermediate bounded workflow took 143,931 ms after reusing those 21 batches; that is a resumed model run, not a cold before/after benchmark. Its independent review passed style but still found attribution and unsupported mechanism errors, so it was not accepted. Final sender-provenance validation remains separate.

## Sender provenance and independent editorial adapter

The sender-provenance cold Qwen-only run processed the same 2,649 permitted inputs with 25 new summary batches and one invalid-reference batch repair, then selection, composition and whole-profile editing: 29 calls, peak four workers, 291,501 ms. Independent Claude review returned style_passed=true but passed=false with four material attribution/terminology findings. This is a failed quality run.

The writer now accepts an optional separate gateway/model for whole-profile editing, defaulting to its configured generation gateway. The production code contains no Claude CLI dependency and does not automatically send content to a second service. 122 affected model, sensitivity, Profile, provider and composition tests passed; changed-source/test ESLint and diff whitespace checks passed. The persisted input fingerprint also includes the generation-policy version.

An isolated independent-editor attempt reused the same 25 summaries and made fresh Qwen selection/composition calls, but the private Claude CLI adapter rejected the JSON Schema 2020-12 dialect identifier. It did not produce an accepted Profile. The CLI-only adapter removes that unsupported dialect identifier while retaining field constraints, and its resumed run reuses the already saved Qwen selection/composition responses. Any resulting duration is editorial/resume time, not a cold scan or cold Profile benchmark. Original Profile and Feishu state must remain unchanged. Final independent-editor semantic acceptance is recorded separately below.

The first independent Claude edit completed in 89,295 ms after reusing Qwen selection/composition and 25 summaries. Separate Claude review passed style but failed two attribution claims: an assistant-reported decision became a personal judgment, and forwarding a filming arrangement became arranging it. The final writer therefore separates whole-draft critique from whole-draft editing; the editor receives the critique alongside the same original evidence. This adds one model call and no keyword-based cleanup. 122 related tests passed again. Runtime compilation succeeded; an incidental root workspace build later failed when the missing Electron binary tried to download under restricted networking, so this is not desktop-build acceptance.

The first critique/edit CLI run expired at its 180-second isolated overall deadline. A plain-completion retry then returned a provider HTTP 502 after about 182 seconds, without an accepted Profile. A further same-model retry uses low CLI effort and a 300-second isolated overall budget. These CLI runtime limits are private harness settings, not a production timeout change or a successful performance benchmark. Final runtime typecheck and changed-file lint passed; the model-schema, author-provenance and independent-review feedback tests remain 122 passing.

The bounded CLI adapter maps CompleteRequest.maxTokens to the supported CLI output-token environment and disables implicit API retries. The critique request still returned HTTP 502; a minimal request containing no private material also returned HTTP 502 in 579 ms with no successful model usage. Current final live acceptance is therefore incomplete, rather than a pass. The last generated independent-editor draft still has two known attribution findings. The new background branch has independently reported latest-writer integration, 184 tests/build/lint passing, two real incremental batches with six writer calls, restart deduplication and zero idle calls; that confirms lifecycle behavior, not final portrait semantics.
