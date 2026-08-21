# @deepseek-ai/dsh-hub-client

English | [中文](README.zh.md)

Cordis plugin that connects to a remote Hub server and exposes its sessions and Agent commands through the Harness client. Install it on the machine running the browser or another client application; the optional [`dsh-client-ui-hub`](../../client/ui-hub/README.md) package displays its connection status.

## Configuration

The plugin persists Hub connections under `hub.endpoints`. Each entry may enable `registerAgent`; that option makes the same Host also register its local directory through an Endpoint Agent. The node's `agentEndpointId` is generated once, persisted in the settings namespace, and is independent of every Hub identity. The remote endpoint identity is not configurable on the Client: a successful Hub handshake is its only source. Before that handshake, `/api/hub/status` reports `endpointId: null` and no remote transport is registered. The plugin registers the remote session provider and the `/api/hub/status` web endpoint used by the optional UI package, then disposes the connection with the plugin fiber.

The package also exports `HubEndpointAgent` for a Host that registers itself with a Hub listener. The Agent requires an explicit endpoint identity, registration token, Host `apiProxy`, and `HubWorkspaceDirectoryProvider`. The provider reads complete `workspace.list` and `session.list` snapshots from that Host; the Agent publishes the snapshot at registration and serially replaces it after workspace or session directory changes.

After registration, the Agent consumes the same Host `api.events.host` stream used by local clients. It determines each frame's workspace from the published directory, forwards the unchanged frame through the Hub, and aborts and awaits the stream during disconnect. An endpoint-wide frame uses `workspaceId: null`; a project frame without a unique owner terminates the bridge instead of being broadcast ambiguously. A directory snapshot failure closes the Agent connection so the Hub cannot continue advertising stale metadata.

The Agent also consumes the official `api.events.mux` stream and forwards each `session/event` envelope unchanged through `hub/event` with endpoint and workspace ownership. Other mux frame types are ignored. A session event whose session is absent from the authoritative directory closes the Agent connection instead of being attributed to an unknown workspace.

An unexpected Hub socket close aborts the Host stream and clears the registration and directory state. When `autoReconnect` is enabled, the Agent waits for the configured `reconnectDelay`, reads a new authoritative directory snapshot, registers a new Hub connection, and starts one replacement `api.events.host` stream. A failed recovery attempt is retried after the same delay. Calling `disconnect()` disables recovery, cancels the pending timer, and waits for the Host stream to stop.

## Installation

Install `@deepseek-ai/dsh-hub-client` through the Harness plugin manager or add its `cordis.patch.yml` row to a profile. The package declares its protocol, session, persistence, and invariant peers; a profile must provide those packages at compatible versions.

## Model Experience

### Remote session provider

#### What the model sees

Indirectly. Remote session events and history are consumed by the normal Harness session and agent composition, so the model sees the same session-visible inputs as a local provider through `SessionPersistence`.

#### Token effect

No additional token effect; the session composition owns prompt assembly.

#### KV Cache effect

No additional effect; the session composition owns provider request assembly and cache behavior.

## Known Limitations and Deferred Work

- **The UI is optional** — installing the client provider without `dsh-client-ui-hub` still provides remote sessions but no settings section.
- **Web routing is deployment-owned** — `RemoteAgentClient` provides the remote execution face; the host API must select it for sessions configured for remote execution.
- **Directory authority is local** — the Agent derives discovery metadata from the owning Host's `workspace.list` and `session.list`; it does not synthesize summaries from individual Host frames.
- **Discovery is separate from projection** — publishing a newly discovered workspace only makes it selectable in settings. The client homepage includes it only after the user selects its `(endpointId, workspaceId)` reference.
