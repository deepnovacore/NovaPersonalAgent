# Five-tab personal space

The desktop personal panel now exposes Todos, Feeds, Ideas, Goals and Profile. Existing proactive reminders, executor tasks, memory inspection and source controls remain reachable through explicit secondary actions.

- Todos are user-owned actions with open/doing/waiting/done/cancelled state, optional due date and goal link. Asking Nova for help drafts a conversation; it does not imply execution or mark the Todo completed.
- Ideas can be edited, archived and converted once each to a Todo or Goal. Related objects survive archiving. Only child-to-parent links are stored.
- Goals have purpose, success criteria and explicit active/paused/completed/archived state. Action progress counts non-cancelled linked Todos; zero Todos does not mean success, and completing all Todos does not automatically complete the Goal.
- Profile edits a user-stated introduction and the single canonical news-interest collection. Existing evidence-backed memories retain their own correction/forget semantics. News reading/saving does not become a personal fact.
- Feeds fetches fixed BBC News, Guardian Technology and IT Home RSS feeds while explicitly enabled. It retains source errors, original links/times, validated model matches, read/save state, topic weights and blocked sources. Polling runs every 15 minutes while the application runs; manual refresh is available. This is not a guarantee of second-level publication latency or all-interest coverage.

## Ownership and persistence

PersonalAgentHost owns the existing authenticated command path and process lock. LifeService and NewsService are separate bounded domains stored beside the host file as `.life.json` and `.news.json`. BoundedJsonStore uses validated input, private files, atomic replacement and directory fsync. There is no second reminder agent, public-article-to-memory ingestion path, or background task created by a news card.

News cache is bounded to 500 articles including at most 100 saved items. Per-refresh model work is at most 24 articles, selected across sources in batches of eight; pending count is visible. Recommendations are restricted to the last seven days, with a per-source display cap and optional unrelated exploration. Stable URL dedupe is implemented; cross-publisher semantic event clustering is not. Failed ranking visibly falls back to a timeline when no current scores exist. Source failures retain cache. Blocked sources are excluded from recommendation but saved articles remain accessible.

## Structured candidates

“整理最新发言” explicitly extracts candidates from the currently selected conversation's latest user message. Source ID, generation, full text and exact span are validated; the result appears in the matching tab for edit/accept/dismiss. Acceptance rechecks the current source, does not itself execute tasks, and Profile acceptance appends with an optimistic version check. Candidates are disposable projections; accepted objects persist. The existing model gateway is the default. Jev is an optional injectable judge, not a hidden production default.

Same-candidate requests are idempotent within the bounded receipt history. Re-extraction that changes generated wording can produce a new candidate ID; semantic dedupe, matching existing objects, proposed revisions and cross-object reasoning remain outside this first version. The explicit introduction does not replace the evidence memory engine.

## Reproducible verification

- Runtime: `npm run build --workspace @nova-audio-agent/runtime`, then `node --test --test-concurrency=4 runtime/dist/test/*.test.js`.
- Desktop: `node --test clients/desktop/test/*.test.mjs`.
- Real RSS + configured model: `node --env-file=/absolute/private.env runtime/scripts/live/news-feed.mjs /absolute/isolated/output`.
- Real host candidate lifecycle: `node --env-file=/absolute/private.env runtime/scripts/live/personal-understanding.mjs /absolute/isolated/output`.
- Isolated Electron: run `clients/desktop/scripts/personal-space-live.mjs` with Electron. `NOVA_SPACE_NEWS_DATA` optionally points to the prior live news cache. `NOVA_SPACE_LIVE_MODEL=1` and `NOVA_SPACE_ENV_FILE` enable the synthetic-message real-model UI check. External browser opening is intercepted after URL validation and reported as such.

Live scripts use synthetic profile/messages, never the user's actual memory database. Model availability is a required gate, not a mocked pass. Browser preview/screenshot is not native acceptance. Human-blinded recommendation quality, broad source coverage, 24-hour stability and a packaged installed release have not been completed by these scripts.
