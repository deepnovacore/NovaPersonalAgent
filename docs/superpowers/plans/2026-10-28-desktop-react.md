# Desktop React Implementation Plan

> **For agentic workers:** use superpowers:executing-plans for inline integration and independent scoped agents under dispatching-parallel-agents for disjoint component trees. User authorized direct execution and one complete delivery.

**Goal:** Replace all PC rendering with React while retaining runtime behavior and layout.
**Architecture:** Declarative TSX components consume existing DOM-free controllers and bridges. Main workbench exposes the existing mountPersonalView lifecycle contract to the retained transport/voice engine. All windows share Radix theme and Lucide icons.
**Tech Stack:** React 19, TypeScript, Radix Themes, Lucide, esbuild, jsdom.
**Spec:** docs/superpowers/specs/2026-10-28-desktop-react-design.md

## Global Constraints
- No changes to runtime/, mobile or website.
- Preserve all protocol, preload, controller, secret, draft and permission semantics.
- Preserve overall layout and button relationships.
- No legacy renderer mounts within React, no DOM emulation shim.
- Session builds/caches in /tmp, authorized by user.
- No publishing, pushing or removal of private character assets.

## Review Focus
- IME submission, conversation changes and failed delivery keep drafts.
- Version conflicts retain edits and refresh state.
- Approval actions remain single flight and tied to correct task.
- Settings secrets stay write only; stale responses cannot overwrite edits.
- Hidden/unmounted windows release subscriptions and animations.

### Task 1: Foundation and integration (root)
- [x] Add behavioral test harness and demonstrate missing React entry failure.
- [x] Add dependencies, isolated renderer bundler, theme, error boundary and ESM entry manifests.
- [x] Rewrite personal workbench in react/workbench.tsx, exposing mountPersonalView contract through react/personal-view.tsx.
- [x] Wire build/start/release paths without changing backend semantics.
- [x] Typecheck and bundle all windows; verify local asset graph.

### Task 2: Chat (chat agent)
- [x] Implement react/chat.tsx exporting ChatPane (forwardRef), c/run/api/onHome/openTask/openSchedule/onPreviewPlan/speakingLevel props.
- [x] Imperative handle: receive(frame), identity(value), setOrb(state), setOrbLevel(level), reveal(), focusReference(refs).
- [x] Rewrite composer, approvals, coding targets, execution cards, build steps and plan preview as React components; preserve command payloads and draft recovery.
- [x] Add behavioral tests for IME, send/voice/dictation, pending approvals and recovery.

### Task 3: Workspace pages (pages agent)
- [x] Implement react/pages.tsx exporting WorkspacePage({page,c,run,api,discuss,startConversation,openTask,openSettings}). Pages: timeline,ideas,goals,feeds,profile.
- [x] Convert supporting cards, forms, sources, preferences, diary/brief and memory/profile view to React; no legacy view mounts.
- [x] Preserve versioned mutations, links, references, archive filters and async states; add behavioral tests.

### Task 4: Settings (settings agent)
- [x] Implement react/settings.tsx default SettingsApp, react/setup.tsx default SetupApp.
- [x] Preserve all fields/panels using existing SettingsController and preload API, declarative React.
- [x] Add write-only secret and async save/category behavior tests.

### Task 5: Auxiliary windows and shell (windows agent)
- [x] Implement react/shell.tsx and react/auxiliary.tsx exporting React apps for orb shell, visor, visor controls, computer bar/edge, memory board and welcome.
- [x] Extract index.mjs transport/audio/device engine with minimal changes; connect shell state through explicit React store/ref adapter rather than manual DOM writes. Expose bootstrap main entry integrating mountPersonalView from react/personal-view.tsx.
- [x] Retain canvas engine refs, permissions and window lifecycle; add behavior tests.

### Task 6: Tasks/schedules/details (tasks agent)
- [x] Implement react/tasks.tsx exports TasksPage({c,run,openTask,api}), TaskDetail({id,c,run,onClose}), ScheduledTasksPage({c,run,api,openTask}).
- [x] Preserve task history, control/approvals, schedules create/edit/delete/timezones, results and memory debug behavior where applicable.
- [x] Add behavioral tests for pending actions and schedule editing.

### Task 7: Integration and complete validation
- [x] Check no entry imports legacy DOM views; remove obsolete view code only after parity checks.
- [x] Execute unchanged DOM-free tests, all new React tests, bundler/typecheck and main asset graph checks.
- [x] Inspect real browser render/screenshots and keyboard flows.
- [x] Independent whole-change review; fix material findings; report exact checks and limitations.

## Final validation

91 React tests,1651 retained desktop cases,39 Playwright React checks,33 baseline checks pass. Renderer strict typecheck and all9 asset graphs pass.50 paired screenshots and8 production captures per phase. Native orb-transparency test cannot start without the cloud Electron binary; native hardware/installer acceptance remains unverified. Independent review findings resolved; no outstanding source change request. See clients/desktop/REACT_MIGRATION.md and local .superpowers/react-migration/final-review.md.
