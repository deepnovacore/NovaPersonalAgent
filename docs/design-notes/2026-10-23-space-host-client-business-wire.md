# Space business wire v1

Host owns this contract. All objects below are JSON plaintext **inside** authenticated E2E relay envelopes; relay must never inspect these fields. Epoch/membership/sender checks occur before dispatch. Names use snake_case. Unknown fields are ignored; v1 is additive. Pairing advertises `business_versions:[1]`; no overlap rejects pairing.

## Client → Host

`{v:1,type:'intent',op_id:string,kind:string,input:object,created_at:number,expires_at?:number,base_version?:number,temp_id?:string,depends_on?:string[]}`. Times are Unix milliseconds. Durable state intents do not expire. `(sender_device,op_id)` identifies an immutable operation; changed content is `op_id_conflict`. Dependencies contain prior op IDs from the same sender. Host returns `dependency_pending` until those succeed; failed dependencies return `dependency_failed`. Any `id`, `goal_id`, `idea_id` referencing an earlier successful `temp_id` is remapped by Host too.

| kind | input |
|---|---|
| `life.mutate` | Existing Life input: `{op:'create',kind:'goal'|'todo'|'idea',title,note?,goal_id?,due?,success_criteria?}`, `{op:'update',kind,id,...fields}`, `{op:'profile',about}`, `{op:'convert',id,target}`, `{op:'undo_create',id,kind}`. Updates/profile/converts carry `base_version` (mapped to expected_version). |
| `snapshot.request` | `{}` |
| `card.dismiss` | `{id,kind:'feed'|'timeline'}` |
| `chat.send` | `{conversation_id:'chat:main',text}`; `expires_at` required, maximum 60 seconds. Send on stream after Host presence check; **never** enqueue offline chat. `op_id` is stable turn ID. |
| `chat.cancel` | `{op_id}` of the original turn; sender must own that turn. |
| `mobile.result` | `{action_id,status:'completed'|'denied'|'failed'|'unknown',result?:object,error?:string}` |

## Host → Client

- Receipt: `{v:1,type:'receipt',op_id,status:'accepted'|'conflict'|'rejected'|'pending',result?:{id,version},id_map?:{[temp_id]:host_id},error?:string,snapshot?:DisplaySnapshot}`. Version conflict includes authoritative snapshot; client retains its pending edit for user resolution. Retry receipt is durable and model execution is not repeated.
- Snapshot: `{v:1,type:'snapshot',snapshot:DisplaySnapshot}`. Replace cache atomically. `DisplaySnapshot={schema_version:1,revision:number,goals:DisplayEntity[],todos:DisplayEntity[],ideas:DisplayEntity[],profile:{about,version},timeline:DisplayCard[],feed:DisplayCard[],notifications:DisplayCard[],chat:DisplayChat[]}`. Entity export allowlist: `id,kind,title,note,status,importance,version,created_at,updated_at,due,goal_id,idea_id,success_criteria,progress`. Card: `{id,kind,title,body,version,created_at?,dismissed?}`. Unknown `kind` renders generic title/body. Chat: `{id,conversation_id,role:'user'|'assistant',text,created_at,turn_id?,status?}`. Never export raw evidence, credentials, profile inferences or source permissions.
- Stream: `{v:1,type:'chat.delta',op_id,conversation_id,text,sequence:number}`; text is **replacement preview**, never append. Best effort only.
- Final: `{v:1,type:'chat.final',op_id,conversation_id,message_id,text,status:'completed'|'failed'|'cancelled'|'interrupted'}`; always durable mailbox, upsert by `message_id`, replace preview by op_id. Host persists admission before model, never re-runs an admitted turn after restart; interrupted recovery sends durable interrupted final.
- Notification: `{v:1,type:'notification',id,title,body,kind,created_at}`; mailbox delivery ID derives from existing notification outbox idempotency key.
- Tool: `{v:1,type:'mobile.action',action_id,tool,args,expires_at}`. Supported explicit actions: `calendar.read` with start/end, `reminder.create` with title/due, `camera.capture` with prompt. No natural language goal / planning / agent runtime. Host specifies action; client checks permissions and persists action_id before any side effect. Duplicate returns same result; uncertain effect reports unknown and never repeats automatically.

## Delivery and crash boundaries

Host keeps metadata-only journal: input fingerprint, receipts, remaps, durable outbound messages, chat admissions, tool actions and inbound cursor. It stores **no Life replica**; existing LifeService/backend is sole authority. Life uses a deterministic request ID, so a crash between Life commit and journal receipt is recovered by the existing Life receipt, never a second mutation. Pending outbound payloads reuse the exact relay envelope/id on transport retry. Chat restart finalizes interrupted admitted turns; network retry/reconnect never invokes model twice. Cursor advances after journal/process durability. Preview never blocks model completion.

## Additional v1 messages

Large snapshots use `{v:1,type:'snapshot.chunk',snapshot_id,index,total,data}`. `data` is a fragment of the complete DisplaySnapshot JSON string split at Unicode code point boundaries, each at most 48 KiB UTF-8; maximum 512 fragments (16 MiB total JSON limit). Clients persist fragments before cursor ACK, join by index and replace the cache only after complete parse. `revision` comes from the durable Space journal and increases across Host restarts.

Space chat user IDs in display snapshots are `user_` + original `op_id`; both user and corresponding assistant carry `turn_id=op_id`. This reconciles the Client pending user bubble with Host durable messages. Final assistant `message_id` remains the persisted Host ID.

`push.register` input is `{handle,credential,gateway_url?}` (opaque gateway credential, inside E2E). Host only accepts its configured HTTPS gateway; it generates a per-handle notification key and sends `{v:1,type:'push.key',handle,notification_key}` through the encrypted mailbox. Client persists this key to the native platform vault before acknowledging. `push.unregister` input is `{}`. Chat finals enter the existing notification producer/outbox and use the same Space relay adapter, durable push reservations and unknown outcome behavior as other notifications. Gateway never receives a Space ID.

`source.input` forwards one phone-collected source operation into the same Host memory ledger. The authenticated sender is injected by Host, never trusted from input. Grant, fact, deletion and explicit correction schemas live in `runtime/src/memory-substrate/space-source-input.ts`; source permission, tombstones, retention and receipt apply in one ledger transaction. This does not create a Hub or second context database.

Snapshot also includes `source_processing:{status:'idle'|'working'|'ready'|'failed',needs_update:boolean}`. This is the current Space's aggregate Host processing presentation status, separate from the accepted upload receipt. Host and Client normalize unknown status values to `idle`. It contains no source names, raw content, inferred profile partitions, references, permissions, detailed errors or task history. An authorized model's inferred profile and projects remain on the Host; only already-approved Timeline/feed summaries use the existing display cards.

Production Host setup uses `nova-space-host init` and a private `NOVA_SPACE_HOST_CONFIG` path. The config pins device identities and the E2E key, fixes the Host role and selects a new private data path. Blackboard, Life, memory ledger, knowledge index, source state, conversations and usage ledger are scoped to that Space; existing independent data is never imported. Local desktop RPCs `space.status`, `space.invitation`, `space.pairings`, `space.confirm_pairing`, `space.revoke`, `space.mobile_action`, `space.mobile_result` expose pairing and explicit action controls. The model uses `mobile__action` with origin-bound authorization and exact action schemas; it never dispatches a phone agent goal.

Pairing requests sign `business_versions:[1]` after the encryption public key. Host rejects a request/member without `selected_version:1`; confirmed membership stores that negotiated version. Invitations advertise Host support `[1]`. Pending pairing and revocation each persist an operation ID before remote mutation and resume that same operation after an unknown HTTP result. Revoked device public keys are retained only to authenticate and discard earlier epoch inbox entries; they never authorize current epoch content or receive keys.

The outbound encrypted cache retains complete randomized envelopes only while sending is unresolved. On an accepted relay response it compacts to a digest/accepted marker; after the Space journal commits removal it settles that marker. Restarts reconcile markers against the pending journal. A later repeat of an already delivered business receipt may use a fresh relay envelope ID; Client deduplication remains `op_id`, `message_id`, notification `id` or `action_id`.
