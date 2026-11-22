# Codex protocol pin

`app-server-schema/0.152.0/` is a trimmed subset of the JSON schema emitted by the
locally installed `codex-cli 0.152.0`. The files are unmodified; only the ones the
tests read are kept (the method and inbound schemas named in
`runtime/src/executors/codex/app-server-schema.ts`, `ClientRequest.json`,
`ServerRequest.json`, the approval params/responses, and the schemas named by
`approval-examples-0.152.0.json`). None of them `$ref` another file.

To pin a new Codex version, regenerate the full schema into a scratch directory and
copy over just those files:

```sh
codex app-server generate-json-schema --experimental --out <scratch>/<version>
```

Re-pick the files from `APP_SERVER_METHOD_SCHEMAS`, `APP_SERVER_INBOUND_SCHEMAS`, the
approval list in `runtime/test/codex-app-server-schema.test.ts` and the `schema`
fields of the examples file, then update the version paths in both tests.

`approval-examples-0.152.0.json` covers launch profiles and approval responses.
`runtime/test/codex-protocol-pin.test.ts` validates these examples against the
snapshot. Transport and broker tests separately exercise binding, advertised
decisions, expiry and cancellation. A schema pass does not replace live
macOS/Windows sandbox and permission tests.
