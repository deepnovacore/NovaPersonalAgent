# Personal memory

Nova learns information from conversations so you can ask about it later. Personal memory is enabled by default and stored locally using mem0.

## Use it

Tell Nova a fact, such as “My example project is Cedar, code C-731.” Later, in a new conversation, ask: “What is Cedar's project code?”

Learning takes time. A new fact may not be searchable immediately; check its learning state in the desktop memory panel.

## View memories

Right-click the orb, open the memory panel, and select personal memory. You can search your original wording, view learned facts and their sources, and browse earlier records.

Search matches original text. Long entries show an excerpt. Inspection currently supports local mem0; the panel does not offer editing or deletion.

## Storage and privacy

Files are stored on your computer under `~/.nova-audio-agent/memory.sqlite.mem0/`, with separate data for each user.

**Local storage is not offline processing.** Extraction and embeddings send relevant text to your configured model service.

Personal memory comes from conversation. Document knowledge comes from files you import. Neither grants permission to execute tasks.

## Change or disable memory

For source use, edit `.env` and restart Nova. No changes are needed for the defaults.

| Choice | Configuration |
|---|---|
| Local mem0 (default) | `NOVA_AUDIO_AGENT_MEMORY_CONNECTION=local`; omit provider |
| Local VoiceMem | `NOVA_AUDIO_AGENT_MEMORY_CONNECTION=local` and `NOVA_AUDIO_AGENT_MEMORY_PROVIDER=voicemem` |
| Disable memory | `NOVA_AUDIO_AGENT_MEMORY_CONNECTION=disabled`; remove provider |
| Remote service | `NOVA_AUDIO_AGENT_MEMORY_CONNECTION=remote`; configure the service URL and token below; remove provider |

Remote connections require `NOVA_AUDIO_AGENT_MEMORY_URL` and `NOVA_AUDIO_AGENT_MEMORY_TOKEN`. The service must implement Nova's memory interface; an arbitrary mem0 endpoint is not compatible. Connection failure reports unavailable rather than switching to local storage.

Changing engines does not migrate existing memories. Disabling memory does not delete stored data. See [configuration](configuration.md) for common settings.
