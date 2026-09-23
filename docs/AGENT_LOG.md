# Agent work log

## 2026-09-23 18:14 CST — Add importable orb skins and Jarvis particle core

- Request: make skin switching/import a supported Nova feature, provide the Jarvis skin package, create an issue and push a feature branch.
- Base: public `main` at `9e1c72574bc7eb038099cd02b02b9c3f6a81c293`; branch `codex/orb-skins`. No internal branch or private pilot integration was used.
- GitHub: [Issue #10](https://github.com/deepnovacore/NovaAudioAgent/issues/10). Keep open for review and release.
- Implementation: validated data-only v1 packages; settings-backed selection/library; static preview, import, remove and skin-specific discard; live renderer lifecycle switching and fallback; trusted particle-core renderer and `skins/jarvis.nova-skin.json`; Chinese/English labels and package documentation.
- Preserves: original Nova rendering and hover palettes, native orb interactions, real audio levels, semantic warnings, reduced motion/high contrast/hidden-window behavior. Appearance fields are excluded from backend restart comparison.
- Validation: runtime TypeScript build; 329 focused offline tests covering skins, settings/store/controller, capabilities validation, existing orb/palette behavior, renderer asset graph and security; desktop JavaScript syntax scan; `git diff --check`; staged sensitive-data scan.
- UI verification: Electron 43.2.0 isolated smoke (`clients/desktop/scripts/orb-skin-smoke.mjs`) passed invalid import, preview, discard, save, reload and remove with no renderer errors. Local screenshot `output/orb-skin-settings.png` visually reviewed; output is ignored and not committed.
- Limits: no full installer/native build, cross-platform GUI test or live voice-provider call performed. This push is source work, not a new installed release. Existing installed client is not replaced. Cockpit transformation and voice-triggered skin switching remain separate work.
- Next: review branch, build/release a desktop version, then import the included package through Settings → General → Orb skin.

## 2026-09-23 18:31 CST — Document the custom skin package contract

- Request: define adjustable parameters, required files and criteria for an approved custom skin.
- Planned commit: `docs: define custom skin package and review specification`.
- Added `docs/SKIN_SPEC.md`: proposed v2 manifest/scene/states/assets format, parameter bounds, host-owned state semantics, accessibility, package validation, lifecycle/performance tests and separate local-install versus official-review results. Linked from the v1 README.
- Explicitly distinguishes implemented v1 behavior from unimplemented v2 design; performance budgets are proposed and require reference-hardware validation. No runtime changes.
- GitHub: continue existing Issue #10 and `codex/orb-skins`; no new issue or release.
- Verification: checked existing schema/state names, Markdown links, whitespace and staged sensitive-data scan. Runtime/UI suites were not rerun for documentation-only changes.
- Next: implement and freeze JSON Schemas and validator before accepting v2 packages.
