# Native phone review checks

Run from this directory with the lane-isolated Gradle/cache environment and real
`NOVA_ANDROID_LINUX_RUNTIME` specified in the engineering brief:

```sh
./gradlew :phone-core:test :app:testDebugUnitTest :app:minifyReleaseWithR8
```

JVM coverage includes the manifest's provider permission, private pairing receiver,
FGS type/subtype, ordered handoff rejection/identity/nonce rotation, runtime UID gate,
own-package launch refusal, task-move ownership, setup stages and running-helper
status during failed re-pairing. Certificate tests verify the Nova CN, signature and
public key. Deleted USB-script, auto-enable and unused wizard/recovery tests are not
part of the supported contract.

## Device-only checks (not claimed by JVM tests)

`NovaShellService` construction requires a shell-uid `app_process`, hidden
`DisplayManager`/task/input services, and real `Surface`/Binder objects. Plain JVM
Android stubs cannot execute its display-scoped methods. On API 31 and 34+, start
the helper from the **minified release APK** and check each method against main
(display 0), a foreign display, a released owned display, and a live owned display:

| Method | Required rejection / ownership behavior |
|---|---|
| `releaseDisplay` | Only removes/releases entries in its own display map; all others are no-ops. |
| `displayFlags` | Returns -1 for displays absent from its own flag map. |
| `startApp` | Returns START_ERROR for unowned display or Nova's runtime package; visible-main task stays on main. |
| `topTaskId`, `topActivity` | Return -1/null without a task query for unowned displays. |
| `injectKey`, `injectTap` | Return false before injection/fallback for unowned displays. |
| `injectStroke` | Return false for unowned displays; recheck ownership under the service lock before **every** timed event. |
| `moveTask` | Only owned→main, or previously moved-out main→owned; the shared predicate is JVM tested. |

`displayOfTask` is a read-only cross-display lookup, not a display-scoped mutation.
During a 10-second stroke, call `releaseDisplay`, `releaseAll` (including app-death
cleanup), or `destroy`: they must not wait on stroke timing sleeps, and no event
may be injected after release. A separate stroke lock serializes strokes without
blocking service teardown.

Also verify on-device:
- Two Flutter engines retain independent channels/preview listeners. Destroy or
  restart one during a method call: its result gets `phone_error/unknown` on
  cancellation and the other engine continues receiving events.
- StrictMode/trace shows status permission and preference queries off main;
  helper/discovery changes emit immediately, permission flags refresh every 2s.
- Deny app notifications or disable the pairing channel: `notifications_allowed`
  is false. Restore them: it becomes true without re-pairing. Chinese/English
  system locales show corresponding copy on the shared pairing channel.
- Unpair unregisters both the settings observer and network callback; an explicit
  subsequent pairing/start re-registers once. It does not auto-enable wireless
  debugging or expose a USB start credential.
- M3 installs/clears its accessibility reader through
  `PhoneBridge.of(context).pairingWindowReader`; M2 intentionally does not edit
  `LocalGuiService` or claim accessibility auto-read works before that wiring.
