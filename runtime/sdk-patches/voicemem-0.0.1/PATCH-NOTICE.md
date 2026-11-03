# VoiceMem 0.0.1 — Nova grounded reply-preference protocol v1

Local modification, 2026-11-03. Modified portions licensed under Apache-2.0.
Original package: `voicemem@0.0.1`, Apache-2.0, VoiceMem-TS repository
https://github.com/deepnovacore/VoiceMem-TS . Original LICENSE and NOTICE.md are
retained alongside every generated SDK copy. This is not an upstream release.

Registry archive integrity (also pinned in the repository lockfile):
`sha512-jt+aB+na+r7cA8BQWMG9Q0V7h3Yt1YpWucN25FGtaMAejwmn121zkg0CxO2DZxM16Y3esNrEQ4eLBi2+TCGhYA==`.
`preimage.json` checks every installed package file, not merely package version.
`patch.json` records exact unique preimage hunks. `grounded-reply-preferences.js`
is the added SDK module. No shared installation is modified.

Changes: replace model-label trait trust with a closed source grammar, canonical
structured claims, per-source evidence snapshots, exact-only canonical attachment,
and dimensionwise conflict suppression before ranking. No model prompt experiment,
threshold adjustment, automatic human correction, or host trait engine is used.

The original public SDK APIs remain; generated `types.d.ts` adds the optional
GroundedReplyPreference record metadata contract. The production engine deliberately
loads the generated SDK, not the pristine registry import. Standard runtime build
postbuild and isolated tests use the identical integrity-gated staging operation.
Unsupported SDK versions/bytes and absent staged SDKs fail closed.
