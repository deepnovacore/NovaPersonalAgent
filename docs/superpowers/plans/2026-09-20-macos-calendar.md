# macOS Calendar implementation
Approved spec: ../specs/2026-09-19-macos-calendar-design.md. User approved implementation and live acceptance. No new features beyond readonly Calendar events.

1. Implement bounded Swift EventKit protocol with status/request_access/list_calendars/snapshot; compile and exercise denied/invalid requests. Native enumerateEvents callback stops at 200, never treats truncation as complete.
2. Build/sign/manifest resource and fixed-path host bridge; reuse existing resource integrity loader. Fail closed on missing manifest or helper. Add full-access usage text.
3. Reuse source connection/current evidence/consent/fences for a macos_calendar provider. Source selection UI includes separate processing consent, default false. Snapshot only reconciles missing objects when complete.
4. Run protocol and state tests, packaged helper validation, real calendar read and UI comparison. Record missing real lifecycle samples honestly. No creation or modification of events without specific authorization.
