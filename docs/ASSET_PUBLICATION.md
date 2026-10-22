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

## Approved default media

On 2026-10-19, the project owner explicitly approved the following exact versions for inclusion in public `v1.0.0dev` source. The integration preserves these files unchanged. This records source publication approval; it does not initiate a push, package release or deployment. New derivatives require separate review.

| File | SHA-256 |
| --- | --- |
| `clients/desktop/src/main/nova-avatar.png` | `06d05cefc061a8f30d154f8a10e4c564d5c703f8d689f657c99d81e522b32469` |
| `clients/desktop/src/renderer/assets/nova-idle.mp4` | `25ae979111e3334a8f08d54e7eb65b18c307834c506f8ae65e7cf7b9ee3ff33c` |
| `clients/flutter/packages/nova_audio/android/src/main/res/drawable-nodpi/nova_orb_avatar.png` | `77fce72aae44c5da545f146c5a1162a05ccf13ed606f0c248e417400354fd1cf` |
| `clients/flutter/packages/nova_audio/ios/nova_audio/Sources/nova_audio/Resources/nova_orb_avatar.png` (identical copy) | `77fce72aae44c5da545f146c5a1162a05ccf13ed606f0c248e417400354fd1cf` |

The owner also explicitly approved the following five UI regression screenshots on 2026-10-19. They contain generic controls and synthetic test copy, with no character media or organization data.

| File | SHA-256 |
| --- | --- |
| `clients/flutter/test/goldens/chat-settings.png` | `bfb4686b1c3bfd5d213d58381a024965e15f8ce9fdcc88ce784bd10cb2c59330` |
| `clients/flutter/test/goldens/chat-home-empty.png` | `e2d50403d7c67fa45bdf6ba1ddf37a704cf3ff1166416b31f7cf19579c65103e` |
| `clients/flutter/test/goldens/chat-home.png` | `83560c8d249fb7102d43690edc059f0f3322eab017e20174c30124127cea14fc` |
| `clients/flutter/test/goldens/chat-conversation.png` | `2067fa863ecdf3910e979c3b8a353eda7a6876a113ba1fe65c44a8ebac212f0f` |
| `clients/flutter/test/goldens/workbench-nova.png` | `e2d50403d7c67fa45bdf6ba1ddf37a704cf3ff1166416b31f7cf19579c65103e` |
