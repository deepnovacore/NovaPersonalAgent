# Plan 3 — installed connector acceptance

Use a local packaged Nova build and isolated acceptance storage. Never publish this package or copy credentials/account IDs/message bodies into the repository. Model processing remains disabled.

1. Validate native manifest, Info.plist calendar usage text and installed helper signature; inspect original client connection settings.
2. Connect actual already-authorized Google identities, choose approved scope, sync and inspect durable complete batch/current evidence. Restart with same storage, verify incremental continuation and preserved scopes/consent. Do not create duplicate authorizations if existing bindings can be safely restored in private acceptance storage.
3. macOS permission approval is explicit in user reply on 2026-09-20. Trigger from packaged Nova, grant full access, enumerate actual calendars, choose readonly scope, sync existing events, compare at least one with Calendar UI. Do not infer Nova grant from terminal helper grant.
4. Verify pause/resume/disconnect and no content processing without consent. Source-service tests cover destructive local delete and generation recovery; do not delete user calendars/events.
5. Record empty calendar, recurrence/cancellation, provider revocation, sleep/wake, second identity and unavailable samples separately. Do not claim them from fake-provider tests.
