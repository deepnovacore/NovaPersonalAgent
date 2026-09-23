# Workbench Content Relevance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make real workbench content reflect eligible, recent work while allowing honest, useful empty states.

**Architecture:** Keep broad authorized indexing separate from the small workbench candidate set. Change whole-computer sampling first, then carry structured provenance and activity through deterministic candidate selection, model generation, and rendering. Preserve saved Life objects and source revocation behavior.

**Tech Stack:** Node 22+, TypeScript runtime, Zod, Electron renderer modules, node:test.

**Spec:** docs/superpowers/specs/2026-09-23-workbench-content-relevance-design.md

## Global Constraints

- The whole-computer grant may read only within its existing authorized root; prioritization never creates another grant.
- Automatic whole-computer scanning skips hidden paths; an explicitly selected hidden priority directory may be included if existing path policy allows it.
- Git activity and modification times are ranking clues, never proof of authorship, ownership, interest, or commitment.
- Saved Todos, Goals, Profile facts, and user-authored memory survive card cache migration and source changes.
- Generated cards may be zero; they never count as saved Life objects or authorize work.
- Public code, tests, and documentation use generic paths and examples. Keep company pilots on internal and preserve the dirty feature/workbench-polish worktree.
- Run runtime and desktop builds serially because both write runtime/dist.
- The final desktop capture uses real local files with a copied, isolated daily profile and covers every workbench page.

## Review Focus

1. An interrupted hidden-file cleanup restarts safely, invalidates old suggestions, and does not delete separately authorized records. Task 1 tests this.
2. A priority directory inside a computer grant changes ordering but not authority; removing priority does not claim revocation. Task 2 tests this.
3. A cloned or recently touched repository cannot become a personal Todo or Goal merely through activity signals. Tasks 3 and 4 test this.
4. A source with partial failures can show eligible known content while the UI still reports incomplete coverage. Tasks 2 and 5 test this.
5. A model paraphrase cannot resurrect a dismissed card, and a failed candidate cannot hide saved content. Tasks 3 and 5 test this.

## File map

| File | Responsibility |
| --- | --- |
| runtime/src/personal-agent/sources.ts | Source authority, whole-computer cursor, hidden-path cleanup, priority directories, context metadata |
| runtime/src/personal-agent/source-priority.ts (new) | Bounded root ordering from explicit selection, current workspace, Git timestamp, and mtime |
| runtime/src/composition/production-composition.ts | Pass an already-authorized committed coding workspace path to the source service |
| runtime/src/personal-agent/context-candidates.ts (new) | Classify source roles and select a small, diverse, deterministic card input set |
| runtime/src/personal-agent/workbench-context.ts | Versioned cache, stable candidate IDs, dismissals, and generation lifecycle |
| runtime/src/model/model-adapters.ts | Constrained card prose and memory overview synthesis |
| runtime/src/personal-agent/host.ts | Join memory and source candidates without losing provenance |
| clients/desktop/src/renderer/connections-panel.mjs | Display priority directories as priorities under a computer grant |
| clients/desktop/src/renderer/personal-view.mjs | Saved records first, generated suggestions second, truthful empty states |
| clients/desktop/src/renderer/life-view.mjs, news-view.mjs, memory-overview.mjs | Page-specific content and fallback copy |
| clients/desktop/src/renderer/workbench.css | Minimal placeholder treatment; no page redesign |

### Task 1: Whole-computer hidden-path policy and migration

**Files:**
- Modify: runtime/src/personal-agent/sources.ts
- Test: runtime/test/personal-sources.test.ts

**Interfaces:**
- Produces: isAutoHiddenPath(root: string, path: string, priorityDirs: readonly string[]): boolean.
- Preserves: existing LocalDirectorySources command and invalidation behavior.

- [ ] **Step 1: Write the failing source test.** Add a fixture with visible project notes, a hidden tool folder, and a hidden file at the home root. Persist a legacy computer record containing one hidden tracked file. Assert new scans skip both hidden locations and reopening invalidates the legacy reference while retaining visible files and a separate directory grant.

~~~ts
assert.equal(f.sources.contextEntries().some(e => e.content.includes('Hidden tool setting')), false)
assert.ok(f.invalidated.includes(legacyHiddenRef))
assert.ok((await f.knowledge.listSources()).some(s => s.locator.endsWith('project/README.md')))
~~~

- [ ] **Step 2: Run the focused test and observe the failure.** Run: npm run build -w @nova-audio-agent/runtime, then node --test runtime/dist/test/personal-sources.test.js. Expected: the new hidden-path or legacy-invalidation assertion fails on baseline.
- [ ] **Step 3: Implement the policy and durable cleanup.** Use path components relative to the computer root, skip dot-prefixed entries in computer batches unless inside an explicitly selected priority directory, and never index .git internals. Filter legacy hidden files out of contextEntries synchronously, even while cleanup is pending. During source open/sync, mark old hidden tracked files invalid and remove them through #removeFile; retain incomplete cleanup for retry after interruption.

~~~ts
function isAutoHiddenPath(root: string, path: string, selected: readonly string[]): boolean {
  const parts = relative(root, path).split(sep)
  if (parts.includes('.git')) return true
  if (selected.some(value => within(value, path))) return false
  return parts.some(part => part.startsWith('.'))
}
~~~

Here `within` is the existing realpath-aware containment helper; the selected directory itself is validated before it enters this list.

- [ ] **Step 4: Rebuild and rerun the focused test.** Expected: hidden files are absent from automatic computer context, their old refs are invalid, and separately granted data remains.
- [ ] **Step 5: Commit this independently reviewable source-policy change.** Commit source code and source tests together.

### Task 2: Priority directories and fair early sampling

**Files:**
- Create: runtime/src/personal-agent/source-priority.ts
- Modify: runtime/src/personal-agent/sources.ts
- Modify: runtime/src/composition/production-composition.ts
- Modify: clients/desktop/src/renderer/connections-panel.mjs
- Test: runtime/test/personal-sources.test.ts
- Test: clients/desktop/test/connections-panel.test.mjs

**Interfaces:**
- Consumes: isAutoHiddenPath from Task 1.
- Produces: sources.priority.add({path}) and sources.priority.remove({path}); computer snapshot priority_dirs: string[].
- Produces: priorityWorkspace?: () => Promise<string | null> in LocalDirectorySourceOptions.
- Produces: orderComputerRoots(roots: readonly RootSignal[]): RootSignal[] where RootSignal contains path, selected, currentWorkspace, lastGitCommitMs, and mtimeMs; tracked computer files use a repository or top-level directory as unit rather than their immediate dirname.

- [ ] **Step 1: Add failing authority and ordering tests.** With a computer grant over a temporary root, select one descendant as priority, verify it appears early, remove priority, and verify the computer grant still covers it. Exercise a non-Git directory and two Git repositories with controlled commit times; the current workspace path outside the grant must be ignored. The first batch should represent more than one non-hidden top-level root.

~~~ts
await f.sources.command('sources.priority.add', {path: project})
assert.deepEqual(f.sources.list()[0]?.priority_dirs, [project])
await f.sources.command('sources.priority.remove', {path: project})
assert.equal(f.sources.list()[0]?.state, 'connected')
assert.ok(f.sources.evidenceSnapshot().some(item => item.summary.includes('project')))
~~~

- [ ] **Step 2: Run the focused runtime and desktop tests to see the missing command and ordering fail.** Run the runtime build/test from Task 1; run node --test clients/desktop/test/connections-panel.test.mjs.
- [ ] **Step 3: Add the persistent priority list and fair queue.** Validate selected paths with realpath, the existing sensitive-path policy, and containment in the computer grant. Persist selected roots in the existing source state schema with a backward-compatible default. Implement bounded Git metadata reads with execFile, a timeout, and no author inference; use mtime for non-Git roots. Interleave early reads across roots, then continue the durable broad queue.

~~~ts
type RootSignal = {path:string; selected:boolean; currentWorkspace:boolean; lastGitCommitMs:number|null; mtimeMs:number}
const priority = (r:RootSignal) => [Number(r.selected), Number(r.currentWorkspace), r.lastGitCommitMs ?? 0, r.mtimeMs]
~~~

- [ ] **Step 4: Wire only an authorized committed workspace and update settings copy.** The composition callback obtains the canonical workspace path and the source service checks containment before ranking. When a computer source exists, the directory chooser calls sources.priority.add and labels it as priority; removing that row calls sources.priority.remove. Without a computer grant, the existing sources.add flow remains.
- [ ] **Step 5: Run focused tests, typecheck, and commit.** Expected: fair early coverage, priority semantics, and existing source grant tests pass.

### Task 3: Candidate selection, stable dismissal, and cache upgrade

**Files:**
- Create: runtime/src/personal-agent/context-candidates.ts
- Modify: runtime/src/personal-agent/sources.ts
- Modify: runtime/src/personal-agent/host.ts
- Modify: runtime/src/personal-agent/workbench-context.ts
- Test: runtime/test/workbench-context.test.ts
- Test: runtime/test/personal-sources.test.ts

**Interfaces:**
- Consumes: priority_dirs and source metadata from Task 2.
- Produces: ContextInput = memory entry or file entry with source_id, file_id, root, rel_path, role, mtime_ms, and priority.
- Produces: selectContextCandidates(inputs: readonly ContextInput[]): readonly ContextCandidate[]. File documents may yield Ideas; only an eligible priority-root document with an explicit action line may yield a Todo suggestion. Files never create Goal, Feeds, or Profile cards.
- Produces: candidateId(tab, primaryFileId, fingerprint): string; context snapshot includes candidate_count and empty_reason.

~~~ts
type ContextInput =
  | {kind:'file'; id:string; version:string; content:string; source_id:string; file_id:string; root:string; rel_path:string; role:'document'|'code'|'config'|'cache'; mtime_ms:number; priority:number}
  | {kind:'memory'; id:string; version:string|number; content:string; origin:'stated'|'inferred'}
type ContextCandidate = {candidate_id:string; tab:'todos'|'ideas'; primaryFileId:string|null; refs:{entry_id:string;version:string|number}[]; excerpt:string; reason_code:'document_action'|'document_idea'|'stated_idea'}
~~~

- [ ] **Step 1: Add failing selection tests.** Mix an explicitly selected non-Git note, an active repository README, a tool template Markdown file, a YAML config, a cloned repository, and user-stated memory. Assert root diversity, exclusion of configuration and templates, no automatic personal claim from activity, and candidate_count 0 when none qualify.

~~~ts
const chosen = selectContextCandidates(inputs)
assert.deepEqual(chosen.map(c => c.primaryFileId), ['note-id', 'active-readme-id'])
assert.equal(chosen.some(c => c.primaryFileId === 'config-id'), false)
~~~

- [ ] **Step 2: Add a failing persistence test.** Return the same evidence with different model wording and assert dismissal stays effective. Change the source fingerprint and assert the new version can be considered. Read a legacy cache and assert its old generated cards are not displayed; saved Life objects are outside this cache.
- [ ] **Step 3: Run focused tests and observe the failures.** Build runtime; run node --test runtime/dist/test/workbench-context.test.js runtime/dist/test/personal-sources.test.js.
- [ ] **Step 4: Implement source-role classification, selection, and cache versioning.** Keep path separate from excerpt prose. Treat hidden tool folders, cache/vendor/test-output/install-state paths, JSON/YAML, and raw code as ineligible workbench roles; allow prose documents in eligible project roots, including non-Git roots. Admit user-stated memory where relevant, but do not use inferred source observations as a second copy of the same file. Bound selected roots and one card per file per tab. Derive IDs from tab, stable file ID, and content fingerprint. Drop the old cited-entry bonus. Carry selected evidence versions and priority in the generation key so later better samples trigger regeneration; expose no_eligible_sources separately from model_abstained.

~~~ts
const candidateId = (tab:string, fileId:string, fingerprint:string) =>
  createHash('sha256').update(JSON.stringify([tab,fileId,fingerprint])).digest('hex')
~~~

- [ ] **Step 5: Rebuild, run focused tests, and commit.** Expected: source revocation removes derived cards, paraphrasing does not revive dismissed cards, and a new valid source sample can replace an earlier one.

### Task 4: Model contract and Profile memory prose

**Files:**
- Modify: runtime/src/model/model-adapters.ts
- Modify: runtime/src/personal-agent/workbench-context.ts
- Modify: runtime/src/personal-agent/memory-overview.ts
- Modify: clients/desktop/src/renderer/memory-overview.mjs
- Test: runtime/test/model-adapters.test.ts
- Test: clients/desktop/test/memory-overview.test.mjs

**Interfaces:**
- Consumes: ContextCandidate and candidateId from Task 3.
- Produces: generated cards carrying candidate_id, tab, title, body, and refs; zero cards is valid.
- Preserves: existing Life and source authority; memory overview is a readable evidence summary, not a Profile fact.

- [ ] **Step 1: Add failing model-contract tests.** Fake the gateway returning zero cards, a valid short card, a stale candidate ID, and a card leaking a path/hash/config key. Add a recently touched cloned repository whose document suggests a Todo; assert activity alone cannot turn it into a personal Todo or Goal. Assert zero is accepted, invalid cards are omitted, and valid cards cite only evidence in their admitted candidate.

~~~ts
assert.deepEqual(await generateContext([], signal), {cards:[]})
assert.equal(context.snapshot().cards.some(c => c.body.includes('source:')), false)
~~~

- [ ] **Step 2: Add a failing memory-overview test.** Feed inferred configuration observations and one user-stated fact. The visible overview should be concise and must not concatenate every raw configuration fact; detailed records remain available behind the existing disclosure.
- [ ] **Step 3: Run focused runtime and desktop tests to observe failures.**
- [ ] **Step 4: Change the generation schema and prompts.** Remove per-page quotas. Permit an empty result. Require neutral attribution for source-derived text; Todo and Goal suggestions stay separate from saved objects. Do not produce local-file Feeds cards or first-person Profile identity claims from configuration. Validate candidate/ref membership in the host and use raw-field checks only as a final guard. Replace the overview's every-entry verbatim assembly with a bounded summary and a neutral fallback.

~~~ts
if (!admitted.has(card.candidate_id)) continue
if (card.refs.some(ref => !admitted.get(card.candidate_id)!.refs.some(allowed => sameRef(ref, allowed)))) continue
~~~

- [ ] **Step 5: Rebuild, rerun focused tests, and commit.** Expected: no forced cards, no raw metadata in normal card bodies, and readable Profile summary with underlying records preserved.

### Task 5: Saved content order and truthful empty states

**Files:**
- Modify: clients/desktop/src/renderer/personal-view.mjs
- Modify: clients/desktop/src/renderer/life-view.mjs
- Modify: clients/desktop/src/renderer/news-view.mjs
- Modify: clients/desktop/src/renderer/connections-panel.mjs
- Modify: clients/desktop/src/renderer/workbench.css
- Test: clients/desktop/test/news-view.test.mjs
- Create: clients/desktop/test/workbench-content.test.mjs

**Interfaces:**
- Consumes: candidate_count, empty_reason, source scan state, and priority_dirs from Tasks 2–4.
- Produces: page-level placeholder copy with one state-specific action, without changing command authority.

- [ ] **Step 1: Add failing renderer fixtures.** Exercise no saved Todo, no saved Goal, no source grant, scanning with no eligible candidate, model abstention, partial source error, news disabled, and saved items with no suggestions. Assert official records render before suggestions and no duplicate empty message appears under populated content.

~~~js
assert.ok(text.indexOf('已保存的待办') < text.indexOf('Nova 的建议'))
assert.match(emptyTodos, /还没有待办。想起一件要做的事/)
assert.doesNotMatch(savedTodos, /还没有待办/)
~~~

- [ ] **Step 2: Run node --test clients/desktop/test/workbench-content.test.mjs clients/desktop/test/news-view.test.mjs and observe failure.**
- [ ] **Step 3: Implement content ordering and copy.** Render Life and news content first. Put eligible suggestions in a separately named section capped at three visible items. Show no-eligible, model-abstained, scanning, authorization, and error copy only from verified snapshot state. Give empty placeholders a minimal shared structure and restrained CSS treatment; do not redesign cards or navigation.
- [ ] **Step 4: Run the focused desktop tests, then the desktop suite serially after runtime build.** Reconcile concurrent feature/workbench-polish content changes without overwriting its working tree.
- [ ] **Step 5: Commit the renderer and copy change.**

### Task 6: Integration, independent review, and real-data screenshots

**Files:**
- Create: clients/desktop/scripts/workbench-real-data-capture.mjs
- Test: runtime/test/personal-agent.test.ts
- Test: clients/desktop/test/workbench-content.test.mjs
- Output: private screenshots and a capture report outside Git

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: ten screenshots, an index.html, and a report with source-state, card-count, and real-data/isolated-profile labels.
- Produces: an offline Electron renderer capture using an isolated copy of the real local profile. SQLite databases use online backups; model and external calls stay disabled.

- [ ] **Step 1: Run serial verification.** Run npm run build -w @nova-audio-agent/runtime; node --test runtime/dist/test/personal-sources.test.js runtime/dist/test/workbench-context.test.js runtime/dist/test/model-adapters.test.js runtime/dist/test/personal-agent.test.js; npm run build -w @nova-audio-agent/desktop; node --test clients/desktop/test/connections-panel.test.mjs clients/desktop/test/news-view.test.mjs clients/desktop/test/memory-overview.test.mjs clients/desktop/test/workbench-content.test.mjs; git diff --check. Investigate only concrete failures, then rerun affected checks.
- [ ] **Step 2: Implement a generic capture script and verify its isolation guard.** Accept REAL_PROFILE_ROOT and CAPTURE_OUTPUT as absolute environment paths; refuse overlap with the real profile. Copy only relevant companion JSON and private state into a mode-0700 temporary home; use SQLite online backups for each live database. Instantiate the changed renderer and local memory/personal hosts against the copy, disable the model gateway, and do not edit or reset the live profile. A connected full-app capture with provider credentials was rejected by automatic approval review, so this offline capture is the authorized evidence boundary.

- [ ] **Step 3: Capture every workbench page from the copied real profile.** Save 01-todos, 02-ideas, 03-goals, 04-feeds, 05-tasks, 06-profile, 07-profile-memory-expanded, 08-profile-memory-detail, 09-todos-chat-collapsed, and 10-desktop-orb. Generate an index.html linking each full-resolution image. Record the exact app commit, copy time, source scan state, card counts, and disabled model status. Mark every image and the index as real-data/isolated-profile/offline renderer. If a page is empty, preserve its actual placeholder rather than injecting fixture content.
- [ ] **Step 4: Review the branch with local Claude Opus 5.5 at the user's authorized code/data boundary.** Ask it to challenge source authority, partial-scan behavior, card meaning, empty states, and screenshot evidence. Verify each actionable finding against code and rerun only affected tests.
- [ ] **Step 5: Commit the generic capture script and any verified fixes; leave private screenshots and report untracked outside the public repo.** Provide the image index to the user. Do not merge, push, deploy, or publish without a separate decision.
