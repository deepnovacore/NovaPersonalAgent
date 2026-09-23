# Workbench content relevance and empty states

Status: User-approved design. Product code remains unchanged at this stage.

## Intent and observed failure

The workbench should show a small amount of useful, attributable content about work the user is actually doing. It may show no generated suggestions. An empty page should explain its state and offer an appropriate action. This change concerns content selection, wording, and state semantics; it does not redesign layout or visual style.

The September 23 desktop capture matches the 11 cards in the local context cache. At inspection time, the whole-computer source was still scanning from `/`: 100 files were indexed, 73 came from hidden directories under the home folder, none came from the active development folder, and 374 directories remained queued. Several generated cards cited hidden tool configuration files. This is direct evidence of a biased early sample, not proof that the user's main projects are absent from the computer. The scanner then flattens excerpts into path-prefixed text, the workbench takes the last 40 entries plus previously cited entries, the model is urged to fill five tabs, and the host checks only citation existence. Generated cards appear before saved Life objects. These mechanisms jointly explain the screenshot; changing copy alone cannot fix it.

## Chosen approach and alternatives

Use a bounded, source-aware path from authorized files to workbench candidates. Improve whole-computer sampling, carry provenance and activity metadata into selection, admit only suitable candidates, and let generation abstain. Keep broad authorized search independent of what appears on the workbench.

Changing only the model prompt would leave the biased corpus and cached cards intact. Waiting for the entire `/` scan would leave the workbench empty indefinitely on large or partly inaccessible machines. Using Git commits or file modification times as proof of ownership or commitment would turn activity clues into unsupported personal claims. Those alternatives are rejected.

## Source coverage and authority

For automatic whole-computer discovery, skip hidden path components by default, including hidden files at the home root, hidden directories, and their descendants. Continue the existing credential/system/dependency exclusions. A separately authorized directory source retains its explicit scope, including a hidden directory if the existing path policy permits it. Do not silently widen a grant.

The user chose this meaning for selecting a directory after whole-computer access is authorized: it becomes a **priority directory within the existing computer grant**, not a second grant. Persist a path-specific priority list on the computer source, show it distinctly from directory grants, and allow removal of its priority without claiming the underlying computer authorization was revoked. An explicitly selected hidden directory may be included if the existing path policy permits it; the global automatic hidden-path exclusion still applies elsewhere. Keep overlapping directory grants disallowed, and keep existing independently granted directory sources authoritative for their own subtrees when a computer grant is added later. On upgrade, previously indexed hidden files owned only by the whole-computer source are invalidated and removed through the existing source removal path before they can feed new cards. A separately granted source, saved Life object, and user-authored memory are not deleted. Interruption must be recoverable through the existing durable file state.

The whole-computer walker should give non-hidden home directories fair early coverage instead of consuming its first batches from one alphabetical prefix. Explicit directory sources and the computer grant's priority directories run first. An available committed coding workspace may be prioritized only if its canonical path lies within an already authorized source; it never creates a new grant. For discovered repositories and non-Git directories, use recent Git activity and file or directory modification time as bounded ordering clues. Inspecting a `.git` marker for activity does not make its hidden contents indexable. Put a per-root cap on early excerpt collection, then continue the broad crawl. Activity signals affect sampling and ranking only. They do not establish project ownership, user interest, authorship, or an obligation. If no workspace or Git metadata is available, the fair non-hidden crawl still makes progress. Expose partial coverage honestly; a source-level error does not claim the whole scan failed or completed. The existing `max_files` and byte budgets apply to each scan batch, not to the total lifetime of a whole-computer source.

## Workbench candidate boundary

`contextEntries()` should preserve an authorized source's root, path, source type, file type, modification time, and scan state as structured metadata alongside a screened excerpt. The model should not receive raw path prefixes as prose. User-stated or saved information and source-derived excerpts remain distinguishable. Selection groups candidates by root or repository, favors explicitly selected and currently active roots, then recent activity, and caps each root so one installation or repository cannot dominate. A root's activity may come from Git or ordinary file changes; neither signal claims ownership. Old citations do not reserve places in future generation windows.

Broad search can still index supported code and configuration when a user explicitly grants a directory. Automatic workbench candidates exclude configuration, cache, test output, install state, generated files, and raw code. File role is determined from the path and source context as well as extension: a Markdown agent template, generated report, or dependency README is not eligible merely because it is prose. Repositories prioritized by activity can still contribute their README, design notes, and work logs; code changes themselves are activity signals, not proposed card prose. A readable document from an unknown or third-party project may be searched, but it does not become a first-person commitment. If the currently available sample lacks eligible material, generation returns zero cards; it does not fill pages from lower-quality files. There is no numeric or global scan-complete gate: generation runs when an eligible priority-root sample exists, and reruns when the selected evidence set changes. Until such a sample exists, the page shows its partial-source state without presenting cached cards from the old policy as current advice.

Candidate IDs are stable across wording changes and derive from the tab, primary source's stable file ID, and its content fingerprint, rather than card text. Allow at most one generated card per source file and tab. A changed fingerprint may legitimately create a new candidate; a paraphrase over unchanged evidence may not. Dismissal and source invalidation use that identity. Existing disposable card cache is invalidated on the policy upgrade; where an old dismissal maps unambiguously to a surviving candidate, preserve it. Saved Life objects are not regenerated or removed. A partly failed whole-computer source may still provide candidates from an eligible priority root; no global scan-complete gate is required. The snapshot distinguishes zero eligible candidates from eligible candidates for which the model produced no acceptable card.

## Meaning of each page

- **Todos:** saved or explicitly confirmed Todo items are primary. A source-derived action can only be shown as a clearly separate suggestion when the source itself states a concrete next step and the source is eligible. It is never counted as a Todo or executed until the user records or delegates it.
- **Ideas:** allow a few source-grounded possibilities tied to relevant work. State what the source says and why it may be worth considering; do not fabricate a roadmap.
- **Goals:** formal goals require an explicit user action or statement. A project document's general direction is not a personal goal. Do not auto-fill this page merely to avoid emptiness.
- **Feeds:** show actual public articles and saved items according to the existing news settings. Local file summaries do not masquerade as news. Turning news off does not trigger local-summary filler.
- **Profile:** show confirmed personal facts and the existing explicitly saveable profile draft. Tool configuration, repository topics, and third-party documents do not establish identity or occupation. The memory overview remains a separate evidence summary, but must not expose a stitched list of raw configuration facts as a personal biography.

The generation contract allows zero cards and has no per-tab quota. It receives admitted candidates with stable IDs and typed evidence, then writes concise Chinese titles and bodies. It may not invent a candidate or cite evidence outside that candidate. Host validation rejects missing or mismatched IDs, stale citations, unsupported tab/category combinations, and obvious raw-field or identifier leakage. A failed individual card is omitted without turning unrelated saved content into an error. Keep the user-facing body short; technical evidence belongs behind the existing evidence disclosure.

## Empty and partial states

The renderer distinguishes saved-record emptiness from generated-suggestion emptiness. It shows saved records first. Copy is tied to verified state, with one primary action where useful:

| State | Example copy |
| --- | --- |
| No saved Todo | `还没有待办。想起一件要做的事，可以随时记在这里。` |
| No saved Goal | `还没有设定目标。可以先写下想推进的方向，以及怎样算达成。` |
| No eligible suggestion | `目前没有新的建议。你仍可以查询已连接的资料。` |
| Source scan in progress | `正在整理已授权的资料。现有记录可以照常使用。` |
| No authorized source | `还没有连接资料。连接后，Nova 才能根据这些资料提供建议。` |
| Source paused or partly failed | State the affected source and offer source settings; do not imply that all content is missing. |
| News disabled | `资讯更新已关闭。开启后，这里会显示新文章。` |

Do not claim a scan is complete, quote an unsupported percentage, or promise that a suggestion will appear. If a page has saved items, do not show its saved-record empty copy merely because suggestions are absent.

## Verification and delivery boundaries

Focused fixtures should cover: a whole-computer grant with hidden configuration and a recent non-hidden project; fair sampling across roots; adding and removing a priority directory under a computer grant without changing its authority; an existing separate directory grant followed by a computer grant; removal and restart recovery for old hidden entries; a non-Git document; a cloned third-party repository; a recent commit that does not create a Todo or Goal; zero-card generation; stale or mismatched citations; stable dismissal after rewording; and all distinct empty states. Verify that source revocation still removes derived cards while preserving saved Life records. Check existing source, host, model-adapter, and desktop renderer contracts for regressions.

Use synthetic fixtures for automated checks. After implementation, copy the daily profile into an isolated test profile and run the changed desktop client against that copy and the user's actual local sources. Capture every workbench page—Todos, Ideas, Goals, Feeds, Tasks, and Profile—plus the expanded Profile memory state and relevant collapsed-chat/orb states if their content changes. Label the result as real-data acceptance on an isolated profile; do not pass off fixtures, source wiring, or a copied profile as a mutation-free run on the live daily profile. Preserve the original profile and the dirty `feature/workbench-polish` worktree, and reconcile its content changes before integration. Keep public code and tests generic: no local organization names, paths, personal data, or pilot integrations.
