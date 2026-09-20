# Nova bilingual redesign implementation plan

Goal: implement the approved deep-space art direction and complete Chinese/English home and docs.
Architecture: shared server-rendered page components receive a language flag, distinct root layouts set document language, small client components own star animation, language switching and clipboard feedback.
Tech: existing React / Vinext / TypeScript / Canvas 2D; no new dependencies.
Spec: ../specs/2026-09-05-bilingual-design.md

1. Replace accumulated CSS overrides with one responsive system. Build the original animated star field and editorial homepage.
2. Provide localized shared header, footer and install command. Serve /, /docs, /en and /en/docs with correct lang and titles. Preserve anchors on switching.
3. Rewrite Chinese copy naturally, author equivalent English, preserve accurate release caveats and upstream source links.
4. Format touched files, check types and production build, request all four routes, inspect desktop/mobile views and language switch behavior. Keep the local preview available.
