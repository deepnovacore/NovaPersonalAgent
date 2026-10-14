# Sources and connectors

Nova only reads what you explicitly connect — local folders, mail and calendars, and Feishu chats — and only lets a model process that content once you separately consent to it.

## Connect, consent, pause, disconnect, delete

| Action | What it does |
|---|---|
| Connect | Grants access to a source: a folder, an account, or a set of chats |
| Consent to processing | A separate switch letting the configured model service read the content; a source can be connected without it |
| Pause | Keeps the connection and everything already collected; just stops new reads |
| Disconnect | Stops local collection but keeps already-collected data (and, for Feishu, your app configuration). For services connected through Composio it does not revoke the OAuth grant you gave; revoke that separately in Composio or the service itself if you need to |
| Delete history / local data | Removes what was already collected, as a separate step from disconnecting |

## Local files

In settings, under local files, the consent checkbox has to be checked before "choose folder" or "authorize all accessible local files" can be used. Each sync pass reads at most 1 to 200 files and up to 20 MB per source; anything beyond that is deferred to later passes, so this is a per-pass budget, not a lifetime cap. Supported types: text, Markdown, JSON, YAML, CSV, common source-code extensions, PDF and Word (`.docx`).

Version-control, build, dependency and cache directories, and browser profile folders, are excluded automatically. Hidden files and folders are skipped unless you pick them by name; anything your project already ignores in Git is skipped too. Whole-computer access also excludes system and application directories, still respects OS file permissions, processes in batches, and stops reading as soon as you pause it.

## Mail and calendar

| Source | Window | Checked per round | Kept for |
|---|---|---|---|
| macOS Mail | up to 180 days back | up to 500 messages | 180 days after receipt |
| macOS Calendar | — | up to 200 events per page | 30 days after the event ends |
| Composio Gmail | since the last sync, or a fresh snapshot the first time | up to 200 pending changes, 8 message bodies per page | 30 days after the message time |
| Composio Calendar | a configured window of past and future days | — | 30 days after the event ends |

macOS Mail and Calendar use the apps already on your Mac. Composio connects Google Mail and Calendar on any platform through its own OAuth flow, and caps how many source connections one host can hold open at once, at 20. Long message bodies are truncated (around 99,000 characters), with a note pointing back to the original for the rest.

## Feishu

Feishu access goes through your own Feishu app via `lark-cli` — there is no bundled app or shared credential. The connector requires `lark-cli` 1.0.69 or newer and refuses older versions outright.

1. **Connect an app** — create one on Feishu's own developer site, or bind one you already have with its App ID and secret. The secret is only ever piped in, never passed as a command-line argument, and an existing binding is never silently replaced.
2. **Sign in** your account through an OAuth device-code flow.
3. **Choose chats** — pick the real chats you want synced by name; there are no preset categories.

Required scopes cover reading your chat list, reading messages, reading message reactions, plus offline access for the OAuth token. The first sync covers the most recent 7 days, then resumes from where it left off. Text and rich-text messages are stored; attachments are not downloaded, and show a plain notice instead. Only messages from real people are recorded — the bot's own messages are never re-ingested. Message content is kept for 30 days.

Two consents are kept apart. Choosing chats asks you to allow Nova to read them and keep the messages on this computer. A second switch, which lets the model service in Settings process Feishu content, decides whether those messages may be sent to your configured model to build memory. It is off until you turn it on, belongs to the signed-in account, and is cleared when you switch account, when the sign-in expires or when the model service changes. Without it, Nova does not use the messages for memory.

With both in place, a message in a chat you selected that @mentions you directly is recorded as a Todo, showing where it came from. Only mentions from the later of the moment you selected the chat and the moment you gave processing consent are captured, so older history does not become Todos. A Todo can be undone while it is unchanged.

If your Feishu sign-in expires, Nova pauses sync and bot reminders and offers a re-authorize button on the Feishu card. Your app binding, chat selection and local history are kept; you do not need to bind the app again.

Bot reminders are opt-in and delivered only to your own private chat with the bot, never a group. A reminder card can be opened, snoozed or ignored; opening it only navigates to Nova, it does not authorize anything. Credentials are stored in their own directory, isolated from any other app's login.

Disconnecting clears the login but keeps app configuration and history; deleting history clears the collected messages and the memory built from them, and reconnecting later starts a fresh collection.

[Workbench](workbench.md) · [Tasks](tasks.md) · [Personal memory](personal-memory.md) · [Core configuration](configuration.md)

## Scanning and Profile updates

Feishu scans up to four chats concurrently, admits each text page in one ledger transaction, and refreshes source context only when evidence or processing consent changes. Missing structured mention information is fetched with up to four shared detail requests; your own messages need no detail lookup. New windows read newest first. Historical backfills retain their own page tokens while newer-message windows advance separately, with budgets of 20 historical pages and two live pages per round. Unfinished legacy windows keep their original ordering so changing the order cannot skip messages. A failed chat does not block other selected chats.

Composio syncs up to four connections concurrently. Gmail fetches up to four message bodies per batch, with the existing limit of eight bodies per round and its request budget. Failed batches remain pending for retry. Gmail change history follows the provider cursor rather than Feishu's descending-message pagination. Up to four local folder sources scan concurrently with independent recovery checkpoints and existing file and byte budgets; file commits within each source remain ordered. File lookup uses a locator index rather than repeatedly returning the entire knowledge index. Native mail and calendar retain their own paging. The shared extraction queue processes up to four records concurrently, prioritizing direct mentions, then newest evidence. Concurrent results retain authorization and revision checks; conflicted records remain pending for retry.

Profile generates snapshots at cumulative five minutes, thirty minutes and four hours after the first eligible source input, even while sources are still scanning. Further changed inputs trigger updates no more often than every four hours. The anchor and completed stages survive restart. Manual refresh may generate earlier. Updates combine the current Profile with available evidence, retain work and interests whose evidence remains valid, and prune withdrawn or invalid evidence.

Alongside project files, Profile may use your own Feishu messages and sent Gmail messages with processing consent. Gmail requires both the SENT label and a sender address matching the connected account. Received mail and other people's messages are not treated as your own statements. Native mail and calendar lack the same author check and do not enter this direct Profile input path. Inputs are sampled within a bounded budget, so a Profile may not cover the entire history.

Profile message inputs preserve original timestamps, stable author aliases, available display names, threads, and mention targets. Verified sent mail also carries thread and recipient aliases. Direct mentions represent external requests, not confirmed user commitments or completed work. Credentials are screened before generation. Large inputs are summarized with up to four batch workers; unchanged summaries can be reused within the current writer instance. A final evidence check distinguishes the speaker, request target, actual executor, and planned, completed, cancelled, or reverted states. Suggestions remain editable and limited by sampling and model judgment. Completed chats skip unchanged live windows while pending pages and new-message windows continue.

Reply and forward relationship IDs are preserved when available; CLI `reply_to` is normalized to `parent_id`. These links describe message context, not necessarily the author of quoted text. Links outside the authorized Profile sample remain unavailable. Structured verification keeps original message references, and later drafts do not revive omitted message-derived claims.

Profile uses batch indexes to select original messages, without treating index text as facts. Larger inputs select up to 40 representative originals and re-key them into contiguous short references; the adapter restores exact source IDs and versions. After composition, a separate whole-profile critique checks the original evidence; its findings feed a whole-profile edit, keeping attribution and planned/completed states consistent across about, work and interests. Editorial notes stay separate from displayed prose. Grounded synthesis and interpretation are allowed; the prose follows work themes and collaboration, without automatic dates or a stage-by-stage history. Local checks validate structure, references, authorization and explicit credentials instead of guessing meaning from keywords. Platform sender identity is distinct from body authorship: messages carry sender aliases, names and an unverified-authorship marker. Sending a pasted assistant report does not prove personal execution of its results. Configured Qwen3 VL Plus/Flash gateways use bounded thinking, without combining it with JSON mode that does not guarantee structured output; local schema checks and one formatting retry remain. Selection and semantic judgment can still be mistaken, and the Profile stays editable.

The product default preserves ordinary names, email, URLs, machine addresses and code strings. Only explicitly labelled or directly recognizable passwords, API keys, tokens, private keys and credential-bearing URLs are screened, retaining other message context. Unlabelled strings are not classified as secrets by their appearance.

The Profile writer accepts a separate model gateway for whole-profile editing; without one, it uses the configured generation gateway. This is an adapter option, not a bundled CLI dependency or a second provider selected automatically. The persisted Profile input key includes the prose-generation version, so an unchanged source sample can regenerate after a generation-policy update.
