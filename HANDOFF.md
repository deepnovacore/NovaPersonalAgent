# Mobile handoff — thinking, Space UX, voice, connectors, tab transitions

Date: 2026-10-29  
Worktree: `/Users/fishwowater/sqxh/nova-audio-agent/.agents/worktrees/fix/mobile-thinking-and-pages`  
Branch: `fix/mobile-thinking-and-pages`  
Base: `v1.0.0dev` @ `90d0e10a`  
Code HEAD: `c33f0224` (this handoff is a docs-only commit after it)  
Status: **not pushed, not merged**; main checkout `90d0e10a` unchanged; worktree was clean before this doc.

## TL;DR

Five commits implement the agreed mobile fixes:

1. Keep model thinking enabled on both PC and mobile; show a collapsible thinking block (collapsed by default), persist/replay reasoning correctly, and fix Space/profile empty states.
2. Remove duplicate tab titles and refine the Space strip.
3. Simplify voice settings: official endpoints, model/voice dropdowns, realtime vs step-by-step as two tabs (no "advanced" fold).
4. Add a Connectors page (Feishu + system calendar/reminders), and fix Feishu existing-app binding by using Feishu's web app chooser instead of a create-only page.
5. Remove the bottom tab-bar backdrop blur and add opaque backgrounds to pushed pages, to stop iOS tab/page ghosting.

Review focus: **Feishu existing-app web flow** (still needs real-device confirmation), **voice config migration/key semantics**, and **ghosting fix trade-off**.

## How to inspect

```bash
cd /Users/fishwowater/sqxh/nova-audio-agent/.agents/worktrees/fix/mobile-thinking-and-pages
git log --oneline v1.0.0dev..HEAD
git diff v1.0.0dev...HEAD --stat
git show <commit>
```

Flutter verification:

```bash
cd clients/flutter
flutter analyze --no-pub
flutter test --no-pub
```

Expected: `No issues found!`; **1072 passed / 5 skipped** (current code HEAD).

## Commit map

| Commit | Scope | Summary |
|---|---|---|
| `cc60c7e8` | PC | Enable Build reasoning capture by default (`build_reasoning` / desktop `buildReasoning`) and update tests. |
| `ee8145b2` | Mobile + iOS | Reasoning streaming/display/persistence, collapsed thinking block, Space top inset, saved profile/timeline loading, precise empty states. |
| `b26ce378` | Mobile UI | Drop duplicate tab titles; Me keeps a gear-only bar; open task keeps back only; refine Space strip typography/letter spacing/switch. |
| `afb903bb` | Mobile | Voice settings (official endpoints, dropdown catalogs), Connectors page, Feishu create/manual entry paths, remove bottom `BackdropFilter`, opaque pushed pages, tests/goldens. |
| `c33f0224` | Mobile | Feishu CLI web app chooser (`/page/cli?...&from=cli`), profile copy/actions now "连接器", About-me copy, realtime/step-by-step voice tabs, tests/goldens. |

Total across the branch: 66 files, +4295 / −638 (including goldens).

## What changed, per area

### 1. Thinking / reasoning (`cc60c7e8`, `ee8145b2`)

- DeepSeek Chat Completions thinking stays **enabled** on PC and mobile; no `thinking: disabled` / `enable_thinking:false` was added for chat. Voice cascade and profile budget keep explicit `disableThinking: true` for latency/budget.
- `model_client.dart` parses `reasoning_content` / `reasoning`, counts it toward output budget, emits it as `reasoning`, and replays DeepSeek assistant `reasoning_content` when tools are present (legacy assistant messages get `''`; other hosts strip it).
- iOS native parser (`ModelStreamParser.swift`) and `IosModelClient` forward reasoning; `AgentCoreHost` accumulates/resets per round, stores it on assistant/tool-call/interrupted messages, checkpoints it; conversation recovery restores it.
- UI: new `thinking_block.dart` — collapsed by default, header "思考/正在思考", one-line summary, elapsed, expandable selectable text (max height 320). Live `ChatActivity` shows summary/details; persisted assistant/tool-call turns show the block above content; interrupted turns keep partial reasoning.
- Space/profile: standalone subtree consumes the top inset only once (`MediaQuery.removePadding`); `FeishuHost.restored` lets local profile/timeline render while sources are still opening; empty states now distinguish opening failure, not restored, no stored result, generation status, and configured/authorized/syncing causes.
- PC: `runtime/src/config/config.ts` and desktop `settings-defaults.mjs` default to capturing Build reasoning.

### 2. Tab titles and Space strip (`b26ce378`)

- Tasks list and Timeline root no longer have an AppBar/title; the bottom tab bar names them.
- Me has a compact gear-only top bar; an open task chat has only a back button.
- Nova keeps the avatar + "Nova" title (brand/home, not a tab label).
- Space strip: explicit styles/letter spacing for name and "独立运行", compact Space switch, 0.5px separator; smaller vertical padding.
- Goldens updated for the shell.

### 3. Voice settings (`afb903bb`, redesigned in `c33f0224`)

- Built-in integrated providers always use their official WSS endpoint; the endpoint is no longer shown or editable. Historical custom endpoints are normalized to official (user-approved), with an inline notice if that means the saved key must be re-entered.
- Provider catalogs copied from PC:
  - Qwen models 3.1/3.0/3.0-flash/omni; voices by model (3.1 → `longanqian_v3.1`, omni → `Ethan`, default → `longanqian` list).
  - StepFun `stepaudio-3-realtime-preview` + `default`.
  - OpenAI `gpt-realtime-2.1-mini` / `gpt-realtime-2.1` + `marin/cedar/alloy/coral`.
  - Gemini `gemini-3.8-live` + `Kore/Puck/Aoede/Charon/Fenrir`.
- Realtime vs step-by-step are now two clear tabs/segmented tabs at the top. The selected tab is the pipeline; only that pipeline's fields render. Realtime tab: provider/model/voice/API key. Step-by-step tab: existing ASR/fast-LLM/TTS fields (functionally unchanged; endpoints for those advanced stages are still visible).
- No advanced fold, no duplicate "语音模式" dropdown, no overlapping headings; API-key helper shortened; new/edited labels are bilingual.
- Saved model/voice values absent from the catalog are kept as extra dropdown options (no free text). Provider change resets defaults and key input; model change resets the default voice.
- `VoiceSettings` validation/merge semantics were not changed: blank key is retained only when provider and endpoint match; changing endpoint requires re-entering the key.

### 4. Connectors and Feishu (`afb903bb`, `c33f0224`)

- Settings "更多 → 飞书" is now **Connectors**; new `ConnectorsPage`:
  - Feishu row: status chip (reading / not connected / waiting for authorization / syncing / connected), subtitle, opens the existing `FeishuDirectPage`.
  - System row: Calendar & reminders, read-only, permission requested on first in-chat use.
  - Footer: read-only authorization, more connectors later.
- Feishu setup now offers:
  - **通过飞书网页绑定** (web app chooser).
  - **手动绑定已有应用** (App ID + Secret) as fallback; validation `cli_` + non-empty secret; page-owned busy state so a running message sync does not block it.
- **Existing-app web flow**: The registration API returns `verification_uri_complete` on `/page/launcher`, but that page is create-only ("创建飞书智能体应用"). `c33f0224` instead opens Feishu's CLI configuration page with the same device code:
  `https://open.feishu.cn/page/cli?user_code=<code>&lpv=1.0.97&ocv=1.0.97&from=cli`
  This is the page lark-cli uses; it carries the "新建应用 / 选择已有应用" branch. Server URL is validated against official Feishu/Lark hosts; untrusted URLs are rejected. **Real-account end-to-end confirmation is still pending** (see open questions).
- Profile page copy now says Connectors instead of Feishu: empty hints, "Open connectors" button (opens the Connectors page), and About-me footer ("Information from connected sources appears below." / "连接器整理的信息会显示在下方。").

### 5. iOS tab/page ghosting (`afb903bb`)

- Root cause hypothesis: the only `BackdropFilter` (20px blur) in the app was the bottom tab bar; iOS/Impeller can keep stale backdrop samples when the content behind it changes, and transparent pushed routes can show through during transitions.
- Fix:
  - Removed `ClipRect` + `BackdropFilter` + `ImageFilter`; tab bar is now opaque `Nova.ink` with the 0.5px top hairline (height/icons/labels unchanged).
  - `_workspace` Scaffold background `Nova.sheet`; Feishu page `Nova.ink`; local tasks page `Nova.ink`; `NovaPage` was already opaque.
  - No new tab animation; `IndexedStack` semantics unchanged.
- Goldens updated; shell test asserts no `BackdropFilter` remains.
- **Device visual confirmation pending**; if ghosting persists, next step is a screen recording + an Impeller-disabled diagnostic build (not committed).

## Key files

- Thinking: `clients/flutter/lib/ui/thinking_block.dart`, `chat_activity.dart`, `conversation/local_chat_panel.dart`, `agent_core/model_client.dart`, `agent_core/agent_core_host.dart`, `ios/Runner/ModelStreamParser.swift`.
- Space/profile: `space/space_root.dart`, `connectors/feishu/host.dart`, `context/profile_repository.dart`, `ui/local_profile_results.dart`, `ui/profile_generation_status.dart`, `ui/app.dart`.
- Voice: `voice/voice_settings.dart`, `voice/voice_settings_sheet.dart`.
- Connectors/Feishu: `ui/connectors_page.dart`, `ui/feishu_direct_page.dart`, `connectors/feishu/app_registration.dart`, `connectors/feishu/api.dart`.
- PC default: `runtime/src/config/config.ts`, `clients/desktop/src/main/settings-defaults.mjs`.
- Tests: `test/model_reasoning_test.dart`, `test/chat_reasoning_test.dart`, `test/feishu_host_restore_test.dart`, `test/profile_empty_hint_test.dart`, `test/voice_settings_sheet_test.dart`, `test/connectors_page_test.dart`, `test/feishu_app_registration_test.dart`, plus updated profile/space/navigation tests and goldens.

## Verification evidence

- Flutter: `flutter analyze --no-pub` clean; `flutter test --no-pub` **1072 passed / 5 skipped** at `c33f0224`.
- iOS native parser self-check: `ModelStreamChecks.swift` updated and previously run in the first round.
- PC: `cc60c7e8` was verified with the PC suites at that time (**88 runtime + 252 desktop tests passed**). No PC code outside that commit changed in this branch; rerun if policy/docs need fresh evidence.
- Device: Apple build **1.0.0 (5)** is installed on the test iPhone (iOS 26.6) and launched; data was preserved. The acceptance build temporarily strips Push/App Groups entitlements (personal team limitation); source entitlements are restored and not committed.
- Build toolchain: Xcode 16.4 plus the mounted iOS 18.5 Simulator runtime at `/Volumes/iOS 18.5 Simulator` (must stay mounted for device builds); outputs are on the external volume. The official/TestFlight build should be reinstalled after acceptance.
- No push/merge; main worktree's pre-existing changes were not touched.

## Known risks / open questions for reviewers

1. **Feishu existing-app web chooser is unverified on a real tenant.** The new `/page/cli?...&from=cli` URL is the lark-cli one-click page; if the phone still shows only create, we need a different web/API flow. The `lpv=1.0.97&ocv=1.0.97` values are copied from lark-cli and are a maintenance risk.
2. **Feishu CLI page is an undocumented surface.** Security/product should confirm it is acceptable; manual App ID/Secret remains as a fallback.
3. **Official endpoint normalization** changes historical custom endpoints for built-in providers (user-approved). A saved key for the old endpoint is not reused; the sheet tells the user to re-enter it.
4. **Ghosting fix is a hypothesis.** Removing the blur is visually minimal but needs real-device confirmation; if it persists, investigate Impeller vs route backgrounds.
5. **Acceptance build lacks Push/App Groups.** Reinstall the official/TestFlight app after device acceptance.
6. **PC settings migration and Client↔Host settings sync are recommendations only** (see below); no protocol code was added.

## Recommendations carried over from the review discussion

- Mobile settings should stay lean: Model, Voice, Connectors, Language, Phone schedules, Activity, Local data. Do not clone the PC settings tree.
- Client mode: Host projections are authoritative; reading is via snapshot and writes via intents. A future phase can sync an allowlisted, non-secret subset (model/voice/connector status) Host→Client read and Client→Host write; keep language/avatar/notifications local; API keys write-only; no executors/MCP/paths/developer settings. This is a protocol/authority change (medium-high cost), not part of this branch.

## Suggested reviewer checklist

- [ ] Feishu URL construction: official-host validation, no secrets, manual fallback, `from=cli` page choice; try with a real Feishu tenant and confirm "选择已有应用" appears and binds.
- [ ] Voice: tab save semantics, provider/model/voice defaults, catalog correctness, official endpoint normalization + key re-entry, no overflow at 390px, cascaded behavior unchanged.
- [ ] Profile/Connectors copy and action routing.
- [ ] Ghosting: tab/page transitions on a real iPhone; if not fixed, gather a recording.
- [ ] Thinking: DeepSeek reasoning replay only for DeepSeek; legacy/non-DeepSeek hosts strip it; collapsed-by-default UI.
- [ ] Tests/goldens: full suite, no accidental changes in golden content beyond intended UI/copy.
- [ ] PC default reasoning change and whether the default is intended.

## Next steps

1. User verifies Feishu existing-app chooser on build 5; if still create-only, switch to a different Feishu web-login/app-list flow.
2. User verifies voice tabs, profile Connectors copy, and tab/page ghosting on the iPhone.
3. If accepted, reinstall official/TestFlight build; keep this branch for review/merge decisions (not pushed).
4. Separate follow-up: Client↔Host allowlisted settings sync design, and any PC settings migration items if desired.
