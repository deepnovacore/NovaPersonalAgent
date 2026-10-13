# Character and IP publication policy

Generic character selection, state-machine and rendering capabilities can be public. A concrete character and its assets require a separate publication decision.

- New and unreviewed assets default to confidential. Public release requires recorded approval for specific files and versions.
- Review covers names, character registration/defaults, source portraits, animation clips, derived images, prompts, examples, test fixtures, documentation, screenshots and installer contents.
- Do not copy internal catalogues, character identifiers, approval discussions or private media links into a public repository or PR.
- Public builds must register only approved public assets. An empty character library is valid; do not insert an unreviewed sample to fill it.
- New outfits, animations and other derivatives inherit the source asset's classification until separately reviewed.
- Review the exact outgoing commits and their reachable history, not just the current working tree. Hiding a UI entry, adding an ignore rule, or deleting a file at the branch tip does not remove historical content.
- Work from public ancestry. Never publish a private branch after deleting its private files. Inspect the resulting source and release artifact before distribution.

This policy does not change runtime behavior or add bundled characters. A checklist is not a technical guarantee against every accidental publication; maintainers must also run their approved asset audit and review the results.
