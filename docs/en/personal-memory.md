# Personal memory

The default local ledger supports explicit saves such as “Remember to call me kant.” Nova uses `memory__remember` and confirms only after a durable receipt. A new conversation can read the saved preference immediately, without waiting for extraction or vector indexing; it survives restart. A preferred form of address is not a legal name. Explicit changes and forgetting use the same versioned ledger.

Preferred names and reply style receive priority in conversation context. Use `memory__lookup` to enumerate or read exact saved facts, `memory__recall` to ask about other history naturally, and `memory__evidence` to inspect sources. Ordinary conversations still use background extraction. A turn with explicit saves uses the submitted entries and skips duplicate extraction of the full turn. Conflicts and failures must not be reported as successful saves. Explicit writes are currently unsupported by mem0 and remote backends. Forgetting hides the entry and its operation evidence. Distinct explicit saves remain independent even if they quote the same sentence. Surviving broad quotations may still mention a forgotten fact; forgetting does not delete chat history or guarantee semantic erasure of paraphrases.

Nova learns information from conversations so you can ask about it later. Personal memory is enabled by default and stored locally in the unified memory ledger. It supports conversation recall, source evidence, corrections and forgetting. mem0 remains available as an explicitly selected alternative.

## Use it

Tell Nova a fact, such as “My example project is Cedar, code C-731.” Later, in a new conversation, ask: “What is Cedar's project code?”

Learning takes time. A new fact may not be searchable immediately; check its learning state in the desktop memory panel.

## View memories

[![Nova Profile in the main window](../../assets/features/profile-original.en.png)](../../assets/features/profile-original.en.png)

Use the main window’s memory view to inspect, correct or forget ledger entries. With mem0 selected, right-click the orb, open the memory panel, and select personal memory. You can search your original wording, view learned facts and their sources, and browse earlier records.

Search matches original text. Long entries show an excerpt. Inspection currently supports local mem0; the panel does not offer editing or deletion.

## Storage and privacy

The unified ledger defaults to `~/.nova-audio-agent/workspace-graph.sqlite`; use `MEMORY_LEDGER_PATH` to select another location. With mem0 selected, files are stored under `~/.nova-audio-agent/memory.sqlite.mem0/`, with separate data for each user.

The ledger's sibling `<MEMORY_LEDGER_PATH>.memory/` directory contains `USER.md` for stated user information, one file per goal/todo/idea, and a generated `MEMORY.md` directory. Profile summaries remain derived rather than a second fact store. You may edit marked record bodies; IDs, versions, sources, status and links are maintained by Nova. Corrections enter the same versioned merge path.

**Local storage is not offline processing.** Extraction and embeddings send relevant text to your configured model service.

Personal memory comes from conversation. Document knowledge comes from files you import. Neither grants permission to execute tasks.

## Change or disable memory

For source use, edit `.env` and restart Nova. No changes are needed for the defaults.

| Choice | Configuration |
|---|---|
| Unified local ledger (default) | `MEMORY_CONNECTION=local`; omit provider or select `voicemem` |
| Local mem0 | `MEMORY_CONNECTION=local` and `MEMORY_PROVIDER=mem0` |
| Disable memory | `MEMORY_CONNECTION=disabled`; remove provider |
| Remote service | `MEMORY_CONNECTION=remote`; configure the service URL and token below; remove provider |

Remote connections require `MEMORY_URL` and `MEMORY_TOKEN`. The service must implement Nova's memory interface; an arbitrary mem0 endpoint is not compatible. Connection failure reports unavailable rather than switching to local storage.

The unified ledger can import legacy VoiceMem records without changing the old database. Selecting mem0 does not migrate ledger records or enable ledger-backed source connectors. Disabling memory does not delete stored data. See [configuration](configuration.md) for common settings.
