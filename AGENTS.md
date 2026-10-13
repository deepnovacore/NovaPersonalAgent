# Public and internal development

- `v0.2.0dev` and release branches are public. Company pilots belong only on `internal`; never merge or cherry-pick pilot integrations into a public branch.
- Never push `internal` or private recovery refs/bundles to the public remote. Public fixes may flow into `internal`, not the reverse.
- Public clients may expose a generic, deployment-configured Feishu login module. Do not embed organization domains, employee data, tenant identifiers, internal endpoints, deployment files, work-record/weekly-report pages, or pilot service integrations.
- Before removing or rewriting history, preserve complete private recovery data and verify it. Audit both the final tree and all history reachable from the public refs before publishing.
- Character/IP assets require publication review separately from generic character-system code. New or unreviewed characters and derived media are confidential by default; only explicitly approved public assets may appear in public source, defaults, examples, documentation, screenshots or packages.
- Do not publish internal character catalogues or identifiers. Removing a card from the UI or deleting a file in the latest commit does not remove it from Git history. Start public changes from public ancestry and audit the exact outgoing commits before pushing.
- Keep approved public asset versions and review evidence recorded; an approval does not automatically extend to new outfits, animations, references or other derivatives. See `docs/ASSET_PUBLICATION.md` for the release checklist.
