# Desktop React rendering migration

User authorization: rewrite the complete PC rendering layer in one delivery; use judgment without further design gates. Preserve existing layout, button relationships, user-visible capabilities and TypeScript runtime behavior. Mobile and website are excluded.

## Architecture
React 19 + TypeScript/TSX, Radix Themes, Lucide React. Render all desktop windows using declarative components. Preserve DOM-free controllers, protocol messages, preload API, audio/camera/graphics engines and persistence semantics. No React wrappers that mount legacy DOM renderers. Canvas/video engines may use refs and effects. Existing class names and layout CSS provide the geometry baseline; theme tokens and accessible reusable components improve typography, spacing and states.

Build renderer bundles as local ESM (.mjs) and CSS for Electron's restricted nova protocol. No remote script/style/font assets, no weakening CSP. Bundle before source startup and release staging. Outputs and caches use an explicit output root; this session user approved /tmp memory filesystem. Keep runtime/, mobile, main business logic and preload unchanged except minimal renderer asset routing/build wiring.

## Coverage
Main workbench, chat/composer, build execution and approvals; timeline/ideas/goals/news/profile; tasks/schedules/details/memory; settings and all settings panels; welcome/setup; orb shell, visor/controls, computer overlays and memory debug board. Keep entry filenames/URLs stable.

## Alternatives
Incremental feature delivery was recommended for risk control; user explicitly chose a single complete rewrite and delivery. Internally independent components can be implemented concurrently, with one integrated verification gate.

## Verification
Behavioral React DOM tests, unchanged controller tests, renderer bundling/typecheck, static graph/CSP checks, browser screenshots and interaction verification. Verify runtime diff is empty. Exercise disconnected/pending/error states, IME composer, draft recovery, versioned mutations, approval decisions, settings write-only secrets, window cleanup and reduced motion. Report limitations with evidence; do not call incomplete migration complete.
