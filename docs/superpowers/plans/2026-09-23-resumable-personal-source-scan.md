# Resumable Personal Source Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authorized whole-computer scan finish or report bounded partial coverage, surface verified excerpts incrementally, and prove the workbench on the original native profile.

**Architecture:** Keep the existing source grant, knowledge service, host, and renderer. Replace mutable directory offsets with a durable directory ledger; separate discovery, ingestion, observation, and UI updates. Coalesce candidate changes before model generation and run final acceptance through the production Electron entry point against the original profile.

**Tech Stack:** Node 22+, TypeScript, Electron, Zod, existing `KnowledgeService` and personal-source JSON state, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-23-resumable-personal-source-scan-design.md`

## Global Constraints

- Whole-computer authorization covers user-selected priority directories; selecting one does not create another grant.
- Hidden paths are excluded automatically unless explicitly selected and permitted by the existing sensitive-path policy.
- Activity only ranks candidates; it never proves authorship, ownership, interest, or commitment.
- Filename or metadata-only records cannot produce workbench content; valid screened excerpts are required.
- `scan_pending` means unfinished work, including future retries; historical failures alone cannot keep `state:error`.
- The first implementation treats file watcher events as hints; bounded reconciliation provides recovery after lost events and restarts.
- First-open saved content is immediate. Scan progress publishes at most every two seconds. Initial generation waits three quiet seconds with a ten-second maximum; later automatic generations wait thirty quiet seconds with a two-minute maximum, and are limited to one per two minutes and six per hour.
- Final acceptance uses the original profile and actual files in the production native window; a backup is for recovery only. The acceptance run must not send data to providers outside the explicit Claude Opus 5.5 authorization or the original source's still-valid persisted processing grant.
- Do not merge, push, deploy, or commit profile data, screenshots, private paths, or company pilot integrations to the public branch.

## File map

- `runtime/src/personal-agent/sources.ts`: source lifecycle, durable work queue, metadata and content admission, diagnostics.
- `runtime/src/personal-agent/source-walk.ts` (new): bounded, restart-safe directory enumeration and directory identity.
- `runtime/src/personal-agent/source-priority.ts`: existing root ranking; add fair scheduling helpers without changing ownership semantics.
- `runtime/src/knowledge/service.ts`: preserve bounded ingestion failure codes for the scanner.
- `runtime/src/personal-agent/workbench-context.ts`: coalesced and rate-limited candidate generation.
- `runtime/src/personal-agent/host.ts` and `runtime/src/composition/production-composition.ts`: separate source progress from evidence change and broad discovery.
- `clients/desktop/src/renderer/personal-view.mjs`: preserve active-tab focus and scroll on materially changed snapshots.
- `runtime/test/personal-sources.test.ts`, `runtime/test/knowledge-service.test.ts`, `runtime/test/personal-agent.test.ts`, `clients/desktop/test/workbench-content.test.mjs`: focused behavior tests.
- `clients/desktop/src/main/main.mjs` and `runtime/src/composition/production-composition.ts`: acceptance-only profile identity and provider gate before normal host open.
- `clients/desktop/scripts/workbench-native-live-acceptance.mjs` (new): launch and read-only count/screenshot orchestration; it must not create its own BrowserWindow or copy the profile.

## Review Focus

1. A file crosses the body budget after being queued: it leaves the active batch, receives an explicit deferred outcome, and does not spin.
2. A directory changes while the app is closed: restart re-enumerates it without relying on a stale offset or deleting unseen evidence.
3. A selected file is replaced by a same-size, same-mtime file: bounded content recheck invalidates the old fingerprint and derived card.
4. An inaccessible or unmounted root remains unavailable: its indexed evidence is retained, and one local failure does not turn the whole grant permanently red.
5. Many files arrive during first open while the user edits a Todo: source progress and cards update in batches without repeated model calls, tab switches, or lost focus/scroll.

---

### Task 1: Terminating queue and truthful source state

**Files:** Modify `runtime/src/personal-agent/sources.ts`; test `runtime/test/personal-sources.test.ts`.

**Interfaces:** Existing `LocalDirectorySources.list()` keeps the legacy `state` and `scan_pending` fields. Add bounded item disposition and optional `coverage`/`health` fields to `SourceSnapshot`; old persisted states remain readable.

- [ ] **Step 1: Add failing queue and legacy-state tests.** Extend `personal-sources.test.ts` using its `fixture()` to authorize a computer root with `max_bytes` below one queued file, call `sources.sync`, reopen, and assert that the same file is not retried in a tight loop. Seed 51 failures and assert open succeeds, snapshot keeps at most 50, and a clean later batch clears health while retaining bounded diagnostics. Add an `index_limit` persisted-pending case by editing the fixture state, without creating 20,000 files.

```ts
assert.equal(source.scan_pending, true)
assert.equal(source.reasons.body_budget, 1)
assert.equal(saved.sources[0].walk.pending.some((file: {path:string}) => file.path === oversized), false)
assert.ok(source.failures.length <= 50)
```
- [ ] **Step 2: Run focused test and confirm failure.** Run `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/personal-sources.test.js`; record the failing test names before editing product code.
- [ ] **Step 3: Implement a single item-disposition helper.** In `sources.ts`, make every branch consuming `walk.pending` call one helper equivalent to:

```ts
function settlePending(record: SourceRecord, path: string): void {
  if (record.walk) record.walk.pending = record.walk.pending.filter(item => item.path !== path)
}
```

Use it for `file_size`, `body_budget`, `index_limit`, successful ingestion, changed path, and terminal failure. Represent budget deferral in a bounded future-eligible queue rather than re-adding it to the immediate batch. Preserve the existing invalidation-before-replacement fence.
- [ ] **Step 4: Separate current health from historical diagnostics.** Clamp the failure list before every save; derive `error` only from a current source-wide fault or sustained no-progress condition. Keep `scan_pending` true while scheduled work exists, but do not schedule a one-second retry when every item is deferred. Add eligible time and attempt count with a migration default for old walk records.

```ts
view.failures = view.failures.slice(-50)
view.scan_pending = Boolean(walk.queue.length || walk.pending.length || walk.deferred.length)
view.state = grantState === 'paused' || grantState === 'disconnected'
  ? grantState : sourceWideFailure ? 'error' : 'connected'
let due = Infinity
for (const item of walk.deferred) due = Math.min(due, item.eligible_at)
if (Number.isFinite(due)) setTimeout(wake, Math.min(Math.max(1, due - now), 6 * 60 * 60_000))
```
- [ ] **Step 5: Re-run focused tests and commit this complete state fix.** Run the same focused command, then `git diff --check`; commit tests and source changes as one coherent queue/state change.

### Task 2: Restart-safe, fair directory discovery

**Files:** Create `runtime/src/personal-agent/source-walk.ts`; modify `runtime/src/personal-agent/sources.ts` and `runtime/src/personal-agent/source-priority.ts`; test `runtime/test/personal-sources.test.ts`.

**Interfaces:** `scanDirectory(path, signal, onEntry)` streams entries to an idempotent callback and returns `{identity, complete, seen}` with `identity.dev` and `identity.ino` serialized as strings. Child records may be committed in bounded chunks; only a complete pass can reconcile deletions or mark the parent done. The persisted ledger is keyed by canonical path and carries its current generation.

- [ ] **Step 1: Add failing interruption and mutation tests.** In the temp fixture, scan a directory, interrupt after one batch, add a lexically earlier file, reopen, and assert both old and new files are discovered exactly once. Rename or unmount a root and assert its prior evidence is retained. Create an oversized directory and assert `coverage=partial` rather than a thrown `directory_capacity` error. Verify selected/current roots get early work and another root still progresses.

```ts
await writeFile(join(project, 'a-new.md'), 'A newly added note')
await f.reopen()
assert.equal((await f.knowledge.listSources()).filter(item => item.locator.endsWith('a-new.md')).length, 1)
assert.equal(oversized.sources.list()[0]!.coverage?.status, 'partial')
```
- [ ] **Step 2: Run the focused test to capture the current miss.** Run `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/personal-sources.test.js`.
- [ ] **Step 3: Add bounded-memory streaming enumeration.** Use `opendir` with `for await`, process each entry through `onEntry`, and yield the event loop after bounded chunks. At a hard safety cap, probe whether another entry exists before marking partial; a directory with exactly the cap is complete. Compare `lstat(...,{bigint:true})` identity before and after. Return `complete:false` on cap or mutation; do not claim a deletion from that pass. Convert `dev`, `ino`, and `mtimeNs` to decimal strings before persistence.

```ts
const before = await lstat(path, {bigint:true})
let seen = 0, complete = true
for await (const entry of await opendir(path)) {
  if (seen === hardSafetyCap) { complete = false; break }
  await onEntry(entry, currentGeneration) // idempotent child admission; bounded checkpoint chunks
  seen++
}
const after = await lstat(path, {bigint:true})
return {identity: identityOf(after), seen, complete: complete && sameDirectory(before, after)}
```
- [ ] **Step 4: Replace offset checkpoints with a directory ledger.** A queued or interrupted directory restarts from the beginning; a done directory is not re-enqueued in the same generation. Deduplicate with a `Map`/`Set` built from the ledger, not `walk.queue.some`. Only a complete pass on the same reachable filesystem reconciles missing children. Preserve v1 legacy walk migration; make rollback from any new disk shape executable before live acceptance.

```ts
const key = canonicalPath
if (ledger.get(key)?.generation !== generation || ledger.get(key)?.status !== 'done') ledger.set(key, {path:canonicalPath, generation, status:'queued'})
if (enumerated.complete && rootReachable && sameDevice) {
  reconcileChildrenNotSeenInGeneration(canonicalPath, generation)
  ledger.set(key, {...ledger.get(key)!, status:'done'})
}
```
- [ ] **Step 5: Schedule fairly and incrementally.** Use priority buckets for selected/current roots, recent Git activity, and other roots, with a bounded round-robin quota per bucket. Cache Git probes per root and refresh only when its metadata is stale. On completion, schedule age-based reconciliation instead of resetting to a full `/` crawl: selected/current roots are eligible after five minutes, other roots after 24 hours, and both use a global metadata/stat budget per tick. Treat Node watcher events as dirty-path hints; startup/error schedules bounded reconciliation.

```ts
const quota = [4, 2, 1] as const // selected/current, active, other
for (const [tier, turns] of quota.entries()) for (let turn=0; turn<turns; turn++) {
  const item = nextRootRoundRobin(buckets[tier]!) ?? nextAvailableRoot(buckets)
  if (item) schedule(item)
}
```
- [ ] **Step 6: Verify and commit.** Run focused tests and `npm run lint --workspace @nova-audio-agent/runtime`; commit the directory-discovery unit.

### Task 3: Verified content and diagnostic fidelity

**Files:** Modify `runtime/src/knowledge/service.ts`, `runtime/src/personal-agent/sources.ts`, and, only if needed, `runtime/src/knowledge/documents.ts`; test `runtime/test/knowledge-service.test.ts` and `runtime/test/personal-sources.test.ts`.

**Interfaces:** `syncFile()` still throws, but with one bounded stable code from `screening_rejected`, `unsupported_file`, `file_changed`, `file_unavailable`, `embedding_failed`, `store_failed`, `knowledge_busy`, or `ingest_failed`. No exception includes file contents. Existing knowledge callers that only inspect `ingest_failed` retain a compatible generic fallback.

- [ ] **Step 1: Add failing type-specific tests.** Exercise a sensitive-content document, unsupported file, changed file, embedding rejection, and store error. Assert stable codes and no body leakage. Add a source test that a same-size/same-mtime replacement is caught by bounded recheck and that prior card/evidence refs are invalidated before the new excerpt is exposed.

```ts
await assert.rejects(knowledge.syncFile(path, root, signal), /screening_rejected/)
assert.ok(!JSON.stringify(source.failures).includes(secretBody))
assert.equal(sources.evidence(oldRef), null)
```
- [ ] **Step 2: Run `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/knowledge-service.test.js runtime/dist/test/personal-sources.test.js` and confirm the new assertions fail.**
- [ ] **Step 3: Preserve the actual ingestion failure.** In `KnowledgeService.#index`, map `KnowledgeDocumentFailure.code` and known embedding/store errors to stable bounded codes; return `{error:code,id}`. In `syncFile`, throw the returned code directly. In `sources.ts`, avoid converting that code back to generic `source_unavailable`; classify deterministic screening/unsupported outcomes as terminal local skips and transient I/O/busy outcomes as bounded retries.

```ts
const code = cause instanceof KnowledgeDocumentFailure
  ? documentCode(cause.code)
  : signal.aborted ? 'ingest_cancelled' : classifyProviderOrStore(cause)
return {error:code, id:active.id}
```
- [ ] **Step 4: Bind every derived artifact to the verified version.** Reuse the knowledge store's content fingerprint; make observation/card invalidation use `(source id, fingerprint)` and perform the invalidation before publishing a changed excerpt. Re-stat and re-hash selected files on the bounded freshness schedule even if size/mtime match. Do not hash all files on each poll.

```ts
const versionRef = `file:${indexed.id}:${indexed.fingerprint}`
if (previous && refFor(previous) !== versionRef) await invalidateDerived(previous)
tracked.observation_ref = versionRef
```
- [ ] **Step 5: Verify and commit.** Run the focused tests, the source and workbench candidate tests, then `git diff --check`; commit content/diagnostic changes together.

### Task 4: Incremental workbench updates without churn

**Files:** Modify `runtime/src/personal-agent/workbench-context.ts`, `runtime/src/personal-agent/host.ts`, `runtime/src/composition/production-composition.ts`, and `clients/desktop/src/renderer/personal-view.mjs`; test `runtime/test/personal-agent.test.ts` and `clients/desktop/test/workbench-content.test.mjs`.

**Interfaces:** Source progress notification and evidence-ready notification are distinct. `WorkbenchContext.update()` accepts the same entries but schedules model work only when the top candidate signature changes. Host `sourceChanged` invalidates stale refs immediately while coalescing ready/progress notifications.

- [ ] **Step 1: Add failing fake-clock tests.** Feed many source progress updates and assert zero model calls; provide first eligible evidence and assert one call after three quiet seconds or at ten seconds under continuous changes. Provide later batches and assert thirty-second quiet time or two-minute maximum under continuous changes, two-minute minimum spacing, six-per-hour cap, and single-flight behavior. Assert closing or pausing cancels scheduled work. In the renderer test, apply a progress-only snapshot while a Todo textarea is focused and verify focus, typed value, active tab, and scroll remain stable.

```ts
for (let n=0; n<100; n++) await host.sourceProgressChanged()
clock.advance(600_000)
assert.equal(modelCalls, 0)
host.workbenchContext.update([eligibleDocument])
for (let n=0; n<10; n++) { clock.advance(1_000); host.workbenchContext.update([changedEligibleDocument(n)]) }
clock.advance(10_000)
assert.equal(modelCalls, 1) // first eligible set changed continuously
```
- [ ] **Step 2: Run `npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/personal-agent.test.js` plus `node --test clients/desktop/test/workbench-content.test.mjs`; confirm the new tests fail.**
- [ ] **Step 3: Separate progress from content change.** Throttle status projection to two seconds, but do not throttle invalidation. In `host.sourceChanged`, avoid `refreshMemory`, `revalidate`, a state commit, and broad `discover()` when only counters change. Keep existing ready revision deduplication for connector events.

```ts
onProgress: () => host.sourceProgressChanged(),
onChange: changed => changed ? host.sourceChanged({phase:'ready', revision:nextRevision()}) : undefined,
onInvalidate: ref => host.invalidateEvidence(ref),
```
- [ ] **Step 4: Coalesce model generation.** Use the candidate ID/fingerprint signature from `WorkbenchContext` as the key; keep `#run` single-flight and queue one trailing run for changed candidates. Persist `generatedSignature` and recent automatic-call timestamps with the card state, so restart does not reset limits. Schedule a capped change for its next eligible time instead of dropping it. Manual refresh bypasses quiet time and does not consume the automatic hourly quota, but respects single-flight. Preserve the last version-valid cards until replacement, and immediately filter stale cards.

```ts
const schedulerState = {generatedSignature: state.key, automaticCallTimes: state.automatic_call_times}
const due = Math.min(firstChangeAt + maxWaitMs, lastChangeAt + quietMs)
const recent = schedulerState.automaticCallTimes.filter(at => at > now - 3_600_000)
const lastAuto = recent.at(-1) ?? -Infinity
const windowEnd = recent.length >= 6 ? recent.at(-6)! + 3_600_000 : -Infinity
const eligibleAt = Math.max(due, lastAuto + 120_000, windowEnd)
if (signature !== schedulerState.generatedSignature) scheduleAt(eligibleAt) // recheck signature on wake
```
- [ ] **Step 5: Stabilize the active page.** Compute visible-data signatures per selected tab; skip `panel.replaceChildren()` for source-progress-only snapshots. For a material render, preserve a focused editor's identity, current value, selection, and scroll before replacement, then restore them; do not switch tabs or write saved Life records from scan events.

```js
const nextKey = visiblePageKey(selected, c.snapshot)
if (nextKey !== renderedPageKey) {
  const top = panel.scrollTop, edit = captureFocusedEditor(panel)
  renderPanel()
  restoreFocusedEditor(panel, edit)
  panel.scrollTop = top
  renderedPageKey = nextKey
}
```
- [ ] **Step 6: Verify and commit.** Run both focused suites, desktop renderer tests, and `git diff --check`; commit this UI update unit.

### Task 5: Original-profile native acceptance

**Files:** Create `clients/desktop/scripts/workbench-native-live-acceptance.mjs`; modify production diagnostics only where a read-only, environment-gated counter is necessary; test the diagnostic shape with a small desktop test.

**Interfaces:** The script launches `clients/desktop/src/main/main.mjs` through the package's normal Electron entry point and uses the existing profile path. It reads only source/index/candidate/model/render counts and saves artifacts outside both profile and repository. It never calls `app.setPath('userData', copy)` or constructs a replacement workbench BrowserWindow.

- [ ] **Step 1: Add a failing harness contract test.** Verify the script rejects a profile path other than the detected daily original path, an already-held profile lock, an unapproved outbound provider, and any code path that copies/removes `.context.json`. Verify its report includes build commit, original profile path hash, pre/post source counts, eligible candidates, model calls, DOM card counts, remaining queue, and screenshot paths without embedding private content.

```js
assert.equal(report.profile_kind, 'original')
assert.equal(report.native_main, true)
assert.equal(report.source_to_card.rendered, report.dom_cards.todos + report.dom_cards.ideas)
assert.equal(JSON.stringify(report).includes(privateExcerpt), false)
```
- [ ] **Step 2: Add only the read-only diagnostics needed by the normal runtime.** Expose time-series counts behind `NOVA_WORKBENCH_ACCEPTANCE_REPORT` with an explicit output path outside profile/repo; keep it off in ordinary runs. Preflight and gate known runtime/Electron outbound paths before host open: allow Claude Opus 5.5 and any provider whose identity matches the original source's still-valid processing grant, block unrelated news/proactive/connector refresh, and fail closed on an unknown provider. Assert `userData` and blackboard paths resolve to the original daily profile before data opens. Capture the actual native window with OS window capture or a read-only debug protocol. Do not create a second workbench window or seed the profile.

```js
const reportPath = process.env.NOVA_WORKBENCH_ACCEPTANCE_REPORT
if (reportPath) {
  assertOriginalProfilePaths(app.getPath('userData'), blackboardPath)
  assertAcceptanceEgressGateInstalled()
  appendAcceptanceSample(reportPath, {source: sourceCounts(), candidates: candidateCounts(), model_calls: modelCallCounts()})
}
```
- [ ] **Step 3: Verify and commit generic acceptance code first.** Run focused runtime/desktop suites plus build and lint serially. Review `git diff` for private names/paths/data. Commit the generic harness and diagnostics; require a clean tracked tree so the later live report names an exact build commit. Test any migration and down-migration with synthetic fixtures, not the recovery backup.
- [ ] **Step 4: Verify the daily profile boundary before the live run.** Confirm no Nova process owns it; make and hash an immutable recovery backup, verify it without modifying it, and log pre-run profile hashes. Preflight the original embedding provider against its persisted grant or use a local path that preserves grant semantics; `embedding_provider_disabled` or a grant mismatch fails the run rather than counting as an eligible-empty result. Test the outbound gate with a deliberately blocked request before opening the profile.
- [ ] **Step 5: Run the normal native client on the original profile.** Check that saved pages render immediately, scan progress appears in bounded updates, a real excerpt reaches selection, and only authorized model calls occur for eligible content. Wait until no immediately eligible item remains across consecutive scheduler checks, or stop at the run cap and report queue reasons/due times. Capture Todos, Ideas, Goals, Feeds, Tasks, Profile, and expanded Profile memory detail from the same window. Keep reports and screenshots outside the public branch, and re-hash the recovery backup after the run.
- [ ] **Step 6: Review the measured result.** Ask Claude Opus 5.5 for a read-only review of the final diff if CLI access is available, resolve concrete findings, and record whether that review actually completed. Commit only generic follow-up code; do not commit the private report or screenshots.

## Final verification

- [ ] Run `npm run build --workspace @nova-audio-agent/runtime` and `npm run lint --workspace @nova-audio-agent/runtime` serially; run focused runtime and desktop tests. Run broader suites only for a remaining concrete risk.
- [ ] Confirm the branch and main checkout status; preserve main's untracked `references/` and do not merge or publish.
- [ ] Report synthetic tests, local native run, real source coverage, Claude review, and screenshot evidence as separate claims. Link the final native screenshots and report; explicitly state any unscanned roots or providers not exercised.
