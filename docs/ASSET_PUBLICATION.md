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

## Nova Personal Agent desktop Eclipse launcher icon (2026-11-08)

The owner confirmed the desktop display name as Nova Personal Agent (NPA), the mobile display name as NovaCore, and the existing approved white Eclipse logo on all three platforms. Desktop icon sizes below are mechanical resizes of the approved mobile default PNG (`eb8c6a9d101491d0729f2d8e1de6895e8ed172302e8aaaf05cd2687fc8def152`), without new character artwork. Application/storage identifiers remain unchanged.

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

## Public 1.0 documentation media

The owner approved the exact media linked by the release documentation, including the film and gallery sections it links to, on 2026-11-19. Identical copies are listed alongside their source files.

| File | SHA-256 |
| --- | --- |
| `assets/gallery/stills/iphone-feed.webp` | `ad49f0e5e69287254add58ee26e104d6169c89f389bf7f988fc3ac019ddf1b91` |
| `assets/gallery/stills/iphone-morning.webp` | `dd63c33a06af139e72969e3127849c296957b6675b806bf3e7905421c04b77e0` |
| `assets/gallery/stills/pc-build-receipt.webp` | `7f1224ca92329c53812fba0471659f08fad6fec5f8f4665b405320cbc6203fc2` |
| `assets/gallery/stills/pc-computer-use.webp` | `afd07f0c7f79fd0fb5690da98311bb000f3bf48e17808538d839f5a9a6611e8e` |
| `assets/gallery/stills/pc-draft-unsent.webp` | `44afb1013c87757af6cfd3c409fb0996c18aa9c02f47344aaea4e18744213ad0` |
| `assets/gallery/stills/pc-morning-brief.webp` | `812f736d6a2235cafe25f1df9e3790317abb140152b6873f20832fb996ea1272` |
| `assets/gallery/stills/pc-proactive-invite.webp` | `cc9a85f230379a1d85d7e76207795543cee25d04ff0af254dd9688e02dfe4928` |
| `assets/gallery/stills/pc-timeline-cited.webp` | `cf149898bbb72e4408e6839879611b0510d466c681875201df913e17c968776e` |
| `assets/gallery/stills/phone-mobile-result.webp` | `232d5570f0db7019627518319b4970946a4d6ce39d4998dfd4e165bf825d65eb` |
| `assets/gallery/stills/phone-site-dark.webp` | `0da4696d031e13c5abec3ee8dc1ec618f41233e3ac686e76bd65e1fb88eb4edb` |
| `assets/gallery/stills/phone-site-file.webp` | `643b831fa33fffdeaa2a9ab343493e98e5c298836c78d5b29b6bc30399c57e7e` |
| `assets/gallery/stills/phone-site-result.webp` | `192f49e3675c11c7f5f98d7f88a881c21aadc6b618f95df3b9186c9166cf6eaa` |
| `assets/gallery/stills/phone-voice-site.webp` | `a5299cd7362a917a9a2154ca72b2b4f31da2daeaa824f8b1fd79796b32c6bfbe` |
| `website` branch `public/media/clips/ask-first.mp4` | `42921959a9e9475d5724541d5bb5c29bb6122f773731187878f2923c0c841911` |
| `website` branch `public/media/clips/ask-first.webp` | `ada51bcae9cd0f178e4b55034859d8df51d647b4f91c8e59abc06e07c1290973` |
| `website` branch `public/media/clips/computer-use.mp4` | `28b45eef8dba7d62499dd8046051acd7233bd625a9ed0990d60a913e0c44e8ef` |
| `website` branch `public/media/clips/computer-use.webp` | `a910416ceba090497ea800b1237a1174dd008ef8f8ddf263ef999c90f87d7380` |
| `website` branch `public/media/clips/handoff-iphone.mp4` | `1503d710f2b4b20aedc518cecddc6e1ad4c8aff192b1f776f2596c9eb8b1f7d0` |
| `website` branch `public/media/clips/handoff-iphone.webp` | `53cae162bed337329ce0bc7bb5f29fbaf5455e7009018d496620609a19646b6f` |
| `website` branch `public/media/clips/handoff-mac.mp4` | `eb657bce266f656d334f971cfacec3163094f97a64ec875b2857127dfa696918` |
| `website` branch `public/media/clips/handoff-mac.webp` | `d06fb8733d52fb4309277ee88cfbd8fc75270c63a34ddc7bb1ecb4d133fbf9f2` |
| `website` branch `public/media/clips/mobile-use.mp4` | `09f8f2330589cbc9f26fd02be441daa0d6522e4c468c9efc149a60581a7aaf3b` |
| `website` branch `public/media/clips/mobile-use.webp` | `2345e590b4afbaa62237b9f1b23ae018531d181dda0cf88bccc314bb65ec0d35` |
| `website` branch `public/media/clips/morning-brief.mp4` | `6d610f10011d00e681f1a4099e73d4896fdbd0d7c7e19f29b01f0685107222c3` |
| `website` branch `public/media/clips/morning-brief.webp` | `7ab05c0d7eb9f4925bcb949d78499f1ee3441c8528253e8290f6086f26300084` |
| `website` branch `public/media/clips/phone-docx.mp4` | `da7b32057a68bd96c0a6ba5d9a4bffcdcb9d7027ba518b2a7d366ad7bd55720d` |
| `website` branch `public/media/clips/phone-docx.webp` | `fefc26588ea84573e732dac0ca552ac342626b3cbbede4bb6498b94a974c451d` |
| `website` branch `public/media/clips/phone-site.mp4` | `303113355d9aaa82b53fc7ff997c5972d9b2233e181bf6b8df4e18a7df0838ba` |
| `website` branch `public/media/clips/phone-site.webp` | `9258db9fa56937d82b0bcee9a5d4807ee548b7f78dde3a11c074be50eb5d7584` |
| `website` branch `public/media/clips/proactive-draft.mp4` | `3dbc63d9421c6aee425d50b33c1c83b597dcf001deb2ace862086895c18916ff` |
| `website` branch `public/media/clips/proactive-draft.webp` | `aa8fac099a7a207edefc9c81224dccfe16fdb5e7c6ee47cd148768af4dd4c93f` |
| `website` branch `public/media/film/nova-launch-720p.mp4` | `3e225c67494f91cafbaf884487eaad6c0148a334737e321444045975b860c8e1` |
| `website` branch `public/media/film/nova-launch-720p.webp` | `f667dc93f6a772801c4be4f73b460f9ad117cea70d687dbb6dea6c1a9d281791` |
| `website` branch `public/media/gallery/iphone-feed.webp` | `ad49f0e5e69287254add58ee26e104d6169c89f389bf7f988fc3ac019ddf1b91` |
| `website` branch `public/media/gallery/iphone-morning.webp` | `dd63c33a06af139e72969e3127849c296957b6675b806bf3e7905421c04b77e0` |
| `website` branch `public/media/gallery/pc-build-receipt.webp` | `7f1224ca92329c53812fba0471659f08fad6fec5f8f4665b405320cbc6203fc2` |
| `website` branch `public/media/gallery/pc-computer-use.webp` | `afd07f0c7f79fd0fb5690da98311bb000f3bf48e17808538d839f5a9a6611e8e` |
| `website` branch `public/media/gallery/pc-draft-unsent.webp` | `44afb1013c87757af6cfd3c409fb0996c18aa9c02f47344aaea4e18744213ad0` |
| `website` branch `public/media/gallery/pc-morning-brief.webp` | `812f736d6a2235cafe25f1df9e3790317abb140152b6873f20832fb996ea1272` |
| `website` branch `public/media/gallery/pc-proactive-invite.webp` | `cc9a85f230379a1d85d7e76207795543cee25d04ff0af254dd9688e02dfe4928` |
| `website` branch `public/media/gallery/pc-timeline-cited.webp` | `cf149898bbb72e4408e6839879611b0510d466c681875201df913e17c968776e` |
| `website` branch `public/media/gallery/phone-mobile-result.webp` | `232d5570f0db7019627518319b4970946a4d6ce39d4998dfd4e165bf825d65eb` |
| `website` branch `public/media/gallery/phone-site-dark.webp` | `0da4696d031e13c5abec3ee8dc1ec618f41233e3ac686e76bd65e1fb88eb4edb` |
| `website` branch `public/media/gallery/phone-site-file.webp` | `643b831fa33fffdeaa2a9ab343493e98e5c298836c78d5b29b6bc30399c57e7e` |
| `website` branch `public/media/gallery/phone-site-result.webp` | `192f49e3675c11c7f5f98d7f88a881c21aadc6b618f95df3b9186c9166cf6eaa` |
| `website` branch `public/media/gallery/phone-voice-site.webp` | `a5299cd7362a917a9a2154ca72b2b4f31da2daeaa824f8b1fd79796b32c6bfbe` |

## Website homepage media (2026-11-19)

On 2026-11-19 the project owner approved the v4 launch film (which shows the Nova beaver avatar) for the public website. The beaver avatar on the homepage is a byte-identical copy of the `nova_orb_avatar.png` approved on 2026-10-19, so that approval covers it without a new derivative. The poster is a single frame of the approved film (the title card at 13.2 s, no character media), and the voice clip is cut from the film's own evening track (`films/product-v4/public/voice/v_r05.wav`, 2.91–15.51 s) with the same voices the film carries.

| File | SHA-256 |
| --- | --- |
| `website` branch `public/brand/beaver.png` (identical copy of `nova_orb_avatar.png`) | `77fce72aae44c5da545f146c5a1162a05ccf13ed606f0c248e417400354fd1cf` |
| `website` branch `public/media/film/nova-launch-720p.mp4` (v4 launch film, 720p) | `933de2dfb08f5868ba677419b0bb09260b5bea14aa1c0b59bcf173b64cf88d67` |
| `website` branch `public/media/film/nova-launch-720p.webp` (poster frame) | `69abad842279e419131cdf02bfb326fda41ade2b4b78987b319ff921586f0a71` |
| `website` branch `public/media/voice/interrupt.zh.mp3` (evening interruption, 12.6 s) | `3778adb4e3cba312711efa2eaa244c298a94747c3f9501dd50148b14af6f4577` |

## Website feature media (2026-11-19)

On 2026-11-19 the project owner approved these recordings for the public website's feature sections: the R01 Timeline and Profile stills, the R02 and R03 desktop recordings (Timeline → discuss, Timeline → Build), and the three edited phone clips from `nova-v1-launch-work/films/phone-clips/out/`. All use the persona test account. The R03 completion receipt shows the recording machine's local file path; the owner reviewed it and chose not to blur it. No pairing QR codes, fingerprints, AI-generated user avatars or unblurred R04 footage are included.

| File | Source | SHA-256 |
| --- | --- | --- |
| `website` branch `public/media/clips/timeline-discuss.mp4` | R02 `video/02-chat.mp4`, 1600 wide, no audio | `66f30e4b01a55bd4cfb9b61ee70dc38b6a538d35ff64b5d53300dc24d65f3088` |
| `website` branch `public/media/clips/timeline-discuss.webp` | poster frame | `8846dfacd768b7b13f9fcabef64d2ec7e606cac5de85f34e6e0c5709fab47022` |
| `website` branch `public/media/clips/timeline-build.mp4` | R03 `video/03-build.mp4`, 3× speed, no audio | `ec9d9b94c6aac39b72de578421db2e80e5b47682f1f162e24d0a4340f1df9f4e` |
| `website` branch `public/media/clips/timeline-build.webp` | poster frame | `5bf6bd722c9776ffdb9ccfeaf6671c0f83ddc8385564096cdfb359a4d4f1ea80` |
| `website` branch `public/media/clips/phone-paper.mp4` | `Nova-手机-论文.mp4`, 540×960 | `63ab132e069a7644aaf5d41df037d1cae0ab79b97325752a33b21abfe5bb75e2` |
| `website` branch `public/media/clips/phone-paper.webp` | poster frame | `c2e96e835388d2d032195e9cbf19c93840a6cf40299ba21680e22926702601c8` |
| `website` branch `public/media/clips/phone-lunch.mp4` | `Nova-手机-外卖.mp4`, 540×960 | `4ae857f7ec83d70634bc3105560f65a97720225de8ae854abdb7a499cf16ea46` |
| `website` branch `public/media/clips/phone-lunch.webp` | poster frame | `44adb69cb8b7aceffd608349e273000da9ecc2573713da2141e96ed84ee5da00` |
| `website` branch `public/media/clips/phone-site-v2.mp4` | `Nova-手机-个人网站.v2.mp4`, 540×960 | `fa16fde4d3df8317f5a11e05dc5e1ddfe9943515db82c8fd6464db19f1772800` |
| `website` branch `public/media/clips/phone-site-v2.webp` | poster frame | `be662c3768272aa7aadef9a34ae4ee9e2efc3d295d27fdf87d519c841853dddf` |
| `website` branch `public/media/gallery/pc-timeline.webp` | R01 `desktop/stills/lin-timeline-top` | `b4bf4422b1d62e0b7c20bbf6bed7169e672ac4219cb3bf07812a94800a97893c` |
| `website` branch `public/media/gallery/pc-profile.webp` | R01 `desktop/stills/lin-profile-top` | `b6fdb97d2a9102efae9af93216049307220fe9c7980417df5bc6b750efc421e7` |

## Website brand and edited stills (2026-11-20)

On 2026-11-20 the project owner approved these files for the public website and repository: the two phone stills the 1.0.0 release had held back (phone-docx, phone-dual-brain), the back-to-top beaver cutout (a matte of the approved `nova_orb_avatar.png`), the Eclipse app icon used as the site favicon, the Deepnovacore company logos cropped from the 2560 px masked masters, and the website copies of the approved gallery stills whose opaque surround was made transparent.

| File | SHA-256 |
| --- | --- |
| `assets/gallery/stills/phone-docx.webp` | `47a3c751f6a3e73ea7a238c366f8fcd26768def050676ede47d5c24d80bbff2b` |
| `assets/gallery/stills/phone-dual-brain.webp` | `883410ce2495810f7817c08ff9b5923581cb718504affaa37051bebf5c95550c` |
| `website` branch `public/brand/beaver-cut.png` | `98398cbb89e1513dfaa96b1e5b247c93ca780585853bad4d75ffcde18a49ac62` |
| `website` branch `public/brand/nova-icon.png` | `8a67f7cc87a4c70e0cd30ceecad71cb6e9b132add9a722d34257292355aa42fa` |
| `website` branch `public/brand/deepnovacore-logo-en-on-dark.png` | `4e31042d410979845ba218142d0533d2ea94f3edc178fd4cf7fb35d53569b2aa` |
| `website` branch `public/brand/deepnovacore-logo-en-on-light.png` | `25dfd53cb2a2e5bf272cc966d80be75f17f43ea92778ad51cdca50e8566d2cc2` |
| `website` branch `public/brand/deepnovacore-logo-zh-on-dark.png` | `edd5c34c38d81e522f5394ee7413c8a0f3226995dd08d6b29b50dbb568ac9916` |
| `website` branch `public/brand/deepnovacore-logo-zh-on-light.png` | `fc4002311d20beefa69ae9e42129c3b795be3339a3a0af11202b0a91e8e00905` |
| `website` branch `public/brand/deepnovacore-mark-hd.png` | `e8a8e2c3ad8749ae2bd70d9093f2a1eaed301752ca8a309489d3f99e8bd2122d` |
| `website` branch `public/media/gallery/iphone-feed.webp` | `98c5cce5b45786eb571c82c0e4925ecc5b961378b9ec1a59a5beacb6de2c30cf` |
| `website` branch `public/media/gallery/iphone-morning.webp` | `7e136e7aef839de10bceab83eab8e684a86288dc02640271220918b21ae5683f` |
| `website` branch `public/media/gallery/phone-docx.webp` | `306c46d1c4a1725b5d2c3129baf886381656d93edb8a3803ce28547c78d36d1d` |
| `website` branch `public/media/gallery/phone-dual-brain.webp` | `c4a822f15e03e128458905b95df695d82967ea397c8217a32d0e28329c797f9d` |
| `website` branch `public/media/gallery/phone-mobile-result.webp` | `dc2b53d0f5c1ab0429f71d8a7dbd1fdc0004e951945a2239a9313c0c66510f79` |
| `website` branch `public/media/gallery/phone-site-dark.webp` | `5a257780624d9640d2bb2975fe528a2fb668e42dc853fcc5924b6f63f0af7aa6` |
| `website` branch `public/media/gallery/phone-site-file.webp` | `15783bf687e6bdaf934b25cdd747c6346b2f21bde56ba9d43f64baadfb4bbd24` |
| `website` branch `public/media/gallery/phone-site-result.webp` | `3d7eaebd77b5460f80a441d46e6fd096455e4edcf416b37efbee8606daeb744f` |
| `website` branch `public/media/gallery/phone-voice-site.webp` | `123fac705fdf0c3ff5cd8255b3d56722222ae1773300740157652c21ee799b24` |

## Desktop tray icons (2026-11-23)

On 2026-11-23 the project owner reviewed and approved the desktop tray icons introduced in commit `bc7b2ee1` for the public repository and the v1.0.2 release. They replace the earlier crescent tray icon with the Eclipse ring on a dark square, derived from the approved Eclipse app icon. The approval covers these exact files; new sizes or edits need separate review.

| File | SHA-256 |
| --- | --- |
| `clients/desktop/resources/tray/tray-16.png` | `070260a06a4ca6bb9fc4d6434867cafcb8b6672967b1baa1b8e45efe91e76b31` |
| `clients/desktop/resources/tray/tray-16@2x.png` | `7f7191f25c333ba99960947febf23e472ebdffed2abc7fab55033a730675fc6d` |
| `clients/desktop/resources/tray/tray-22.png` | `5e7b3f30bb651a97f56bdf48b50e4d66511ba8c0c0934ca256a78d9f8353755e` |
| `clients/desktop/resources/tray/tray-22@2x.png` | `9db6c945971f84b28c2def6c2de980502f9445aae3f163b60481b13a52510d96` |
| `clients/desktop/resources/tray/tray-32.png` | `7f7191f25c333ba99960947febf23e472ebdffed2abc7fab55033a730675fc6d` |
| `clients/desktop/resources/tray/tray-32@2x.png` | `9a5da61f89f89a68a39ba7196d0a68438ea3c832ac5ee12532303a95492fcd6e` |
