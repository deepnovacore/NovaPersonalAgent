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

## Generic UI screenshot review (2026-10-24)

For the requested v1.0.0dev integration push, the following widget-test screenshots were visually reviewed. They contain generic controls and synthetic test text, with no character media or organization data. This is source screenshot review, not physical-device acceptance. The approved character media above remain byte-for-byte unchanged.

| File | SHA-256 |
| --- | --- |
| `clients/flutter/test/goldens/chat-conversation.png` | `d59353f189a44f7c7daaf68e44e89dac6071f7454b6339d3e876fb5c5907510b` |
| `clients/flutter/test/goldens/chat-home-empty.png` | `ae2c31b8a509e39411100d5fad7f2c51b80aad9751413919168c0fa9c816560e` |
| `clients/flutter/test/goldens/chat-home.png` | `6bb0b56a194968bb551829fa69a7a43287e5d515dd692f0b305776242bf79457` |
| `clients/flutter/test/goldens/chat-settings.png` | `a01f14158740e3d105940d5d93b682b18d6f184ae365d8b48fb003e43da92d0b` |
| `clients/flutter/test/goldens/chat-task-draft.png` | `4d348ce713b62157f61272c67a65263c31252b5e875d8fdee4bcb01a88271f45` |
| `clients/flutter/test/goldens/chat-tasks.png` | `b23eff5ae2da3f6c97f00b11caffcfe661c0f5d6c8807f9c35460145838c340e` |
| `clients/flutter/test/goldens/workbench-nova.png` | `ae2c31b8a509e39411100d5fad7f2c51b80aad9751413919168c0fa9c816560e` |
