# Space Host and relay

This development branch fixes the Host role when a Space is created. Agent runtime and user context stay on the user's computer. The relay only forwards end-to-end encrypted messages and never runs the Agent. A phone creates an independent Space or joins as a Client. Chat requires its Host online; the phone never takes over background work.

Follow the [Space setup guide](../../zh-CN/space-host-client.md) for Host registration, desktop startup and mobile pairing. See the [relay guide](../../../relay/README.md) for self-hosted relay configuration, TLS and Docker. A headless relay and an Agent Host are separate components; the hosted relay is not a runtime deployment target.

The former voice-server/Hub connection flows are retired for new Spaces. Historical release packages predate the Space protocol; build this branch for the new flow. Changing roles creates a new Space without migrating old state. Host loss means Space loss; backup recovery is not provided.
