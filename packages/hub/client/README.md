# @deepseek-ai/dsh-hub-client

English | [中文](README.zh.md)

Cordis plugin that connects to a remote Hub server and exposes its sessions and Agent commands through the Harness client. Install it on the machine running the browser or another client application; the optional [`dsh-client-ui-hub`](../../client/ui-hub/README.md) package displays its connection status.

## Configuration

The plugin profile row owns the remote WebSocket URI and authentication settings. The remote endpoint identity is not configurable on the Client: a successful Hub handshake is its only source. Before that handshake, `/api/hub/status` reports `endpointId: null` and no remote transport is registered. The plugin registers the remote session provider and the `/api/hub/status` web endpoint used by the optional UI package, then disposes the connection with the plugin fiber.

The package also exports `HubEndpointAgent` for a Host that registers itself with a Hub listener. The Agent requires an explicit endpoint identity and registration token, publishes a complete workspace directory, and does not invent identity or reconnect credentials. Directory discovery is separate from session API forwarding.

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
- **Endpoint Agent publication is explicit** — the host integration must provide workspace summaries to `HubEndpointAgent`; this package does not infer or synthesize a directory.
