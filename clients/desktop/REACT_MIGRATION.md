# Desktop React renderer

The PC UI lives in `src/renderer/react/` and uses React 19, TypeScript, Radix
Themes and Lucide. Main workbench/chat, workspace pages, tasks and schedules,
settings/setup and auxiliary windows are declarative component trees. DOM-free
controllers, the TypeScript runtime, preload API, wire messages, native host,
audio/camera engines and canvas renderers are retained. Legacy DOM view sources
remain for existing regression tests/reference, but no compiled UI entry mounts
them or serves them in its production asset graph.

## Build and source startup

Choose an isolated external directory as required by AGENTS.md. This migration
session was explicitly authorized to use `/tmp`.

```sh
export NOVA_DESKTOP_RENDERER_OUTPUT_ROOT=/your/external/worktree-chat/renderer
npm run build:renderer --workspace @nova-personal-agent/desktop
npm run typecheck:renderer --workspace @nova-personal-agent/desktop
npm run test:react --workspace @nova-personal-agent/desktop
```

The full desktop build also bundles the renderer before release staging. Keep
this variable when starting the source app so Main loads the selected output.
Packaged apps contain the bundles at `build/renderer` inside the app. Generation
refuses its source directory and never cleans unrelated output files.

All entries are local ESM/CSS served by the restricted `nova:` protocol. The
audio worklet is a separate self-contained bundle. Release camera smoke uses
its own transitive asset allowlist. Script/style CSP remains self-only, without
unsafe-eval or unsafe-inline allowances or external scripts/styles/fonts.

## Behavior and checks

Existing classes/layout sheets retain the major geometry and button ordering.
The theme improves typography, accents, icons, radii and focus states. Workspace
drafts survive Tasks/inspector/plan navigation; setup password inputs retain
identity across provider switches and submit only active keys. Executor progress
resets on reconnect. Hidden inspectors and unmounted windows release work and
subscriptions appropriately.

`test:react` executes isolated Node/jsdom files covering drafts, IME, approvals,
version conflicts, async responses, settings secrets, window cleanup, package
configuration and compiled local asset graphs.

Reproduce the Playwright comparison with synthetic public data:

```sh
node clients/desktop/scripts/react-visual-compare.mjs --phase before
node clients/desktop/scripts/react-visual-compare.mjs --phase after
```

Artifacts default to `/tmp/nova-react-validation/`: `comparison.html`, paired
screenshots and per-phase `results.json`. Chromium defaults to
`/usr/bin/chromium` (`--chromium` overrides); baseline defaults to `ea0fd201`
(`--base` overrides). `--output` selects an approved `/tmp` subdirectory and
`--renderer` selects the compiled renderer directory.

Browser checks use a mocked Electron bridge. They establish rendering and
browser interactions, not actual microphone/camera/native codec/OS permission,
external authentication, pairing or installed-package behavior. Run the
platform-specific Electron/native acceptance checks before releasing an app.

## Migration-session verification (2026-10-28)

- 91 named React DOM/build tests pass; renderer TypeScript check passes.
- 1,651 named retained desktop tests pass across 147 files. The separate native
  `orb-transparency.test.mjs` file cannot start because this cloud environment
  does not have an installed Electron binary; it is not counted as passing.
- Playwright: 39 React checks and 33 baseline checks pass, zero page errors,
  50 paired screenshots and eight production-entry captures per phase. Main
  outer/content geometry and all 15 settings category column anchors match.
- Every compiled entry's local asset graph loads, including the isolated release
  camera entry, self-contained worklet and approved idle media.
- The tracked diff of runtime, mobile and website source is empty.

Independent review identified packaging, navigation-lifetime, reconnect,
password-retention and localization regressions. They were fixed with targeted
regression tests before the final browser pass. Actual native hardware and
installer acceptance remain outside this cloud verification.
