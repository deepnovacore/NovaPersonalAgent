# Loop Camera

> **Not available in the v1.0 desktop app (deferred).** The desktop conversation runtime keeps the camera module off and the settings page no longer offers a monitor camera or monitor model, so Watch and Guard cannot be started from the desktop app. The capability remains in the runtime: where a host composes the runtime without forcing the camera module off (for example headless or remote deployments), it follows the `camera` module in the capabilities registry and the `MONITOR_CAMERA_DEVICE_ID` and `WATCH_MODEL` environment variables. The rest of this page describes that runtime behavior.

Loop Camera observes a camera with an independent vision model and reports according to your condition. The foreground conversation continues; its model does not need image support.

## Use it

Where the camera module is enabled, configure a monitor camera device and monitor model for the runtime, allow camera access, then describe a condition, such as “Watch this scene and let me know when someone appears.” The selected device remains fixed for that task. Ending monitoring releases the camera.

## Runtime behavior

| Item | Current behavior |
|---|---|
| Concurrency | One monitor at a time |
| Default sampling | Every 2.5 seconds; slow processing does not create a catch-up queue |
| Default duration | 30 minutes |
| Condition hit | Report once and continue; two consecutive misses rearm reporting |
| Consecutive failures | End after three capture or inference failures |
| Stop or timeout | Cancel capture and inference, then release the camera |

Built-in and USB cameras are selected by device ID. A disconnected selected device does not silently fall back to another camera. Network cameras, RTSP, phone cameras and continuous video context are outside current support.

## Compared with conversation vision

Conversation vision captures one frame from the default camera for a submitted transcript or text turn. Loop Camera has its own task, device, sampling interval and model. Images and observations remain evidence; text visible in a frame cannot authorize operations.

See the [support matrix](../support-matrix.md) for model selection and [native vision and independent monitoring](../archs/11-vision.md) for implementation details.
