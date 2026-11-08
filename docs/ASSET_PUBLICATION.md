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
| `clients/flutter/assets/pets/nova.png` (identical copy for the mobile pet avatar; same bytes, no new derivative) | `77fce72aae44c5da545f146c5a1162a05ccf13ed606f0c248e417400354fd1cf` |

The mobile pet avatar asset added on 2026-10-27 is a byte-identical copy of the approved `nova_orb_avatar.png` above, registered as the Flutter default avatar and recorded here without re-encoding. It introduces no new character, outfit or animation, so the 2026-10-19 approval continues to cover these exact bytes. Users may replace the avatar locally with their own photo; that local file is never bundled, uploaded or synced.

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

## UI polish screenshots (2026-10-27, pending owner review)

The UI review polish merges the approved Nova avatar with the "Nova" app-bar title, removes the separate body avatar, and adds a pet-avatar settings sheet plus a "Pet avatar" settings row. The following widget-test goldens were regenerated from the same synthetic fixtures with the documented `flutter test --update-goldens` mechanism. They now contain the approved character media recorded above (no new character, outfit, animation or derivative) plus generic controls and synthetic copy, with no organization data. These exact versions are **pending the project owner's screenshot review** before any push that includes them; the previously reviewed versions remain listed above for history.

| File | SHA-256 |
| --- | --- |
| `clients/flutter/test/goldens/chat-conversation.png` | `9071d3de054667d870eb27c41bd6abf1e31d9f0df25a5ea570e9cf74d47899df` |
| `clients/flutter/test/goldens/chat-home-empty.png` | `12b07d016419c2101023c99674a358353ea70cba2f8538a54d6ab99b57f85388` |
| `clients/flutter/test/goldens/chat-settings.png` | `2613180a6a7c6c07891102ed44a3109e0fb94f64f0e0fd3a834f0d3ac2ffef5d` |
| `clients/flutter/test/goldens/chat-task-draft.png` | `4d348ce713b62157f61272c67a65263c31252b5e875d8fdee4bcb01a88271f45` |
| `clients/flutter/test/goldens/chat-tasks.png` | `5aee5f3acbe7d9790a7377d53fa4fd7c5074e6de626d6eb880cc5e89a4215060` |
| `clients/flutter/test/goldens/workbench-nova.png` | `12b07d016419c2101023c99674a358353ea70cba2f8538a54d6ab99b57f85388` |

`chat-tasks.png` also reflects the Tasks-tab restyle (Tasks/Schedules segmented control, Today/Earlier sections and session-duration labels) added in the same polish pass; the fixture text is still synthetic and no character or organization data was added.

`chat-home-empty.png` and `workbench-nova.png` share a hash because both capture the same empty Nova chat screen. `chat-task-draft.png` matches the 2026-10-19 approved version again: the task chat has no pet avatar in its app bar, and the old body avatar is gone. The pet avatar photo library permission string in `clients/flutter/ios/Runner/Info.plist` is generic; user-chosen photos stay in the app-support directory and are never bundled or synced.

## Mobile document font feasibility review (2026-11-04; not bundled)

Historical pre-bake feasibility record (superseded for new images by the exact
subset approval below): the earlier document acceptance fixture downloaded a
public upstream font only into its isolated test workspace; no font or derivative is added to source, defaults or
packages by this change. This is licence/compatibility evidence, **not owner
publication approval** for a future bundled subset.

- Source: Google Fonts commit `2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc`,
  [`ofl/notosanssc/NotoSansSC[wght].ttf`](https://github.com/google/fonts/blob/2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf).
- Name/version read from the font's name table: Noto Sans SC Thin;
  `Version 2.004-H2;hotconv 1.0.118;makeotfexe 2.5.65603` (variable TrueType).
- Original bytes: 17,772,300; SHA-256
  `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
- Licence: [OFL.txt at the same commit](https://github.com/google/fonts/blob/2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc/ofl/notosanssc/OFL.txt),
  SHA-256 `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`.
  Reviewed text states SIL OFL 1.1, Copyright 2014–2021 Adobe, reserved font name
  “Source”. It permits bundling/embedding/redistribution with the copyright and
  licence, forbids selling fonts alone, and constrains reserved names for
  modifications. A bundled derivative would need its own exact hash, retained
  licence and publication review; this record does not approve one.
- Compatibility: the original TrueType font round-trips Chinese PDF text through
  ReportLab 4.4.4 and pypdf 6.1.1 on Android PRoot and iOS iSH simulators.
  fpdf2 2.8.4 incorrectly drops `fvar` while leaving `avar`; this variable font
  fails its subset path. Static instantiation is diagnostic only, not shipped.

At that earlier measurement no CJK font was guaranteed in production. New baked
images now include the approved subset below; older installed rootfs images
still require availability checks.

## Approved mobile document font subset (2026-11-04)

Approval evidence: **仓库所有者（用户），会话内口头批准** on 2026-11-04
explicitly authorized the renamed common-character Noto Sans SC subset to be
baked into both mobile rootfs images by default. No personal name or ticket was
provided. This approval covers **only the exact derivative below**, not a new
weight, character set, font revision or unrelated asset. Those require renewed
owner approval. This records permission; it does not initiate a push/release or
establish App Store policy compliance.

- Source/version and source SHA-256: the 2.004-H2 variable TrueType at Google
  Fonts commit `2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc` recorded above,
  SHA-256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
- Derivative: **Nova Document Sans SC Regular**, PostScript name
  `NovaDocumentSansSC-Regular`, static `wght=400`; 2,357,940 bytes (original
  17,772,300 bytes). No 700 weight is bundled. Generated with fontTools 4.68.0,
  locked in `clients/flutter/tool/linux/documents/locks/wheels.json`.
- Approved derivative SHA-256:
  `88f7c79e5b9b132c8b455ad2ff8e943d36b5f65aef653c6327e604646f0617e9`.
- Character input: all valid GB2312 characters, ASCII U+0020–007E, U+00A0–024F,
  U+2000–206F, U+3000–303F, U+FF00–FFEF; sorted unique codepoints, UTF-8 with
  trailing newline in `clients/flutter/tool/linux/documents/font-charset.txt`.
  SHA-256 `9bc10dc9de455e72e726e756d8923f6f470d2e39bc3691e17e8c588f860de4b7`.
  This is a common-character subset, not full CJK coverage; missing glyphs must
  not be represented as successfully rendered text.
- Licence/copyright: SIL OFL 1.1, Copyright 2014–2021 Adobe, reserved name
  “Source”. Renamed derivative does not use “Source” in family/full/PostScript
  names; original copyright and licence name records are retained. The exact
  upstream OFL text SHA-256 remains
  `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`.
  Retain that text/copyright alongside the font and in the app licence list;
  do not sell the font alone. Font binaries remain generated build outputs,
  not checked-in media.
- Review evidence: static instantiation + subset + name-table rewrite in
  `prepare_font.py`; both digest-pinned ARM64 Alpine containers generated the
  same derivative hash and ReportLab 4.4.4 → pypdf 6.1.1 read back
  `中文汇总：总和 1001000` offline. This is compatibility/licence evidence in
  addition to, not a replacement for, the owner approval above.
- Installed path: `/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf`;
  licence alongside it and `/usr/share/licenses/nova-document-font/OFL.txt`.

The ReportLab default-font `sitecustomize` hook is code, not a new font asset;
the approved font bytes, character subset, weight and SHA-256 above are unchanged.

## Approved Eclipse mobile launcher icon (2026-11-06)

The project owner supplied and reviewed the silver-white Eclipse artwork and authorized its inclusion in the public `v1.0.0dev` source. Android uses the same bytes as the iOS default appearance. This approval covers the exact launcher assets below.

| File | SHA-256 |
| --- | --- |
| `clients/flutter/ios/Runner/Assets.xcassets/AppIcon.appiconset/AppIcon.png` | `eb8c6a9d101491d0729f2d8e1de6895e8ed172302e8aaaf05cd2687fc8def152` |
| `clients/flutter/ios/Runner/Assets.xcassets/AppIcon.appiconset/AppIcon-dark.png` | `986850bb2f3a892349fbcce6711b05c461a27d0fad30e3e911b0eccd5d4a4e97` |
| `clients/flutter/ios/Runner/Assets.xcassets/AppIcon.appiconset/AppIcon-tinted.png` | `fd33021cb8e7ab29162b784fbff3b055463575d60db5a46ba77fb0d787d1d8d2` |
| `clients/flutter/android/app/src/main/res/mipmap-nodpi/ic_launcher.png` | `eb8c6a9d101491d0729f2d8e1de6895e8ed172302e8aaaf05cd2687fc8def152` |

## NovaCore desktop Eclipse launcher icon (2026-11-08)

The owner authorized rebranding the public clients as NovaCore and packaging all three platforms with the existing approved white Eclipse logo. Desktop icon sizes below are mechanical resizes of the approved mobile default PNG (`eb8c6a9d101491d0729f2d8e1de6895e8ed172302e8aaaf05cd2687fc8def152`), without new character artwork. Application/storage identifiers remain unchanged.

| File | SHA-256 |
| --- | --- |
| `clients/desktop/resources/icon-source/1024x1024.png` | `eb8c6a9d101491d0729f2d8e1de6895e8ed172302e8aaaf05cd2687fc8def152` |
| `clients/desktop/resources/icon-source/128x128.png` | `a5eec4ef43bd53590b4302afb6b33eb6fe4e480ec67f58bafe87cdfcec0eefb4` |
| `clients/desktop/resources/icon-source/16x16.png` | `070260a06a4ca6bb9fc4d6434867cafcb8b6672967b1baa1b8e45efe91e76b31` |
| `clients/desktop/resources/icon-source/22x22.png` | `5e7b3f30bb651a97f56bdf48b50e4d66511ba8c0c0934ca256a78d9f8353755e` |
| `clients/desktop/resources/icon-source/24x24.png` | `efac9cdf8215f289e90a52ad0544890b87a807087878399d9500a5f36006c9b9` |
| `clients/desktop/resources/icon-source/256x256.png` | `247f378b51691c92d0c954be05ea5b9be874ecef6ffcc67d611b664c75d351b5` |
| `clients/desktop/resources/icon-source/32x32.png` | `7f7191f25c333ba99960947febf23e472ebdffed2abc7fab55033a730675fc6d` |
| `clients/desktop/resources/icon-source/44x44.png` | `9db6c945971f84b28c2def6c2de980502f9445aae3f163b60481b13a52510d96` |
| `clients/desktop/resources/icon-source/48x48.png` | `f31b4cc0dd5f94b843c998d86c1ace0e5b65d33412ae899cc39c3f576e52cb67` |
| `clients/desktop/resources/icon-source/512x512.png` | `9f193cf98e4c9381eada1e49d71f3282be8e240a1647a1539756e260adc0051d` |
| `clients/desktop/resources/icon-source/64x64.png` | `9a5da61f89f89a68a39ba7196d0a68438ea3c832ac5ee12532303a95492fcd6e` |
