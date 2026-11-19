# Security & Privacy Architecture

Nova Personal Agent is designed around local-first authority and explicit permission boundaries.

## 1. Space / Host / Client encryption boundary

- **Host holds authority & keys:** All Space private keys, content encryption keys, model API keys, and authoritative personal data remain on the Host (`0700` private directories).
- **Zero-knowledge relay:** The `relay` component only forwards end-to-end encrypted ciphertext between the Host and paired Clients. It never runs the agent or decrypts user content.
- **Push metadata boundary:** `push-gateway` sees only device tokens, delivery timestamps, and ciphertext payload sizes required to wake mobile devices via APNs/FCM.
- **Pairing verification:** Device pairing uses one-time QR codes and explicit full-fingerprint comparison on the Host before content keys are delivered.

## 2. Source access vs. model processing consent

- Connecting a local folder, mail account, calendar, or Feishu source grants **read access** for local indexing, not automatic permission to send content to remote LLMs.
- **Model processing** requires separate, explicit consent. Memory entries and retrieved documents are treated as **untrusted data**, never as instructions that can override host permissions.

## 3. Memory control (Trace, Forget, Purge)

- Personal memory facts stored in the unified ledger (`workspace-graph.sqlite`) retain source provenance and revision history.
- Forgetting or revoking consent writes a tombstone and triggers transactional reconciliation across derived recall indexes (`mem0` / `voicemem`) so deleted facts are not re-injected into prompts.

## 4. Executor & GUI approval gates

- **Coding & Build:** Creating/switching workspaces, file edits, and shell commands are gated by host confirmation and per-action or session-scoped approvals.
- **Computer Use & Mobile Use:** Desktop and phone GUI actions require explicit session admission and action-level approval (`ask` / `never` still requires Connect approval); screenshots are stored as owner-only local artifacts.
- **Reporting vulnerabilities:** See [SECURITY.md](../../SECURITY.md).
