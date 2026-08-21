# @deepseek-ai/dsh-hub-server

English | [中文](README.zh.md)

Cordis plugin that exposes local Harness sessions over WebSocket JSON-RPC. Install it on the machine that owns the sessions; remote clients use [`dsh-hub-client`](../client/README.md) to connect.

## Configuration

The plugin requires an explicit stable `endpointId` and accepts `port`, `host`, `authTokens`, `agentTokens`, and `serverName` in its profile row. `endpointId` is owned by the Host that owns the Hub listener; it is returned during the handshake and is never derived from the client configuration or `serverName`. The Hub's `authTokens` authorize both Client handshakes and Endpoint Agent registration. `agentTokens` optionally replaces that shared authorization for one explicitly named Agent identity. Registered Agents publish workspace summaries through the same listener, and authenticated Clients discover them with `hub/list-endpoints` or `hub/workspaces`. Workspace entries retain their owning `endpointId`, so equal workspace ids on different endpoints remain distinct. API requests carry both `endpointId` and `workspaceId`; the server validates the published workspace, forwards requests for registered endpoints to the owning Agent, and returns the Agent's original API result. The plugin owns the listening server and disposes it with the plugin fiber. The default bind address is loopback; set an explicit non-loopback address only with authentication and a protected transport.

Local session events are forwarded from the Host's official `api.events.mux` stream. The Hub does not rebuild user messages or assistant output; it preserves each `session/event` and delivers it only to Clients subscribed to the owning session. The Host `api.events.host` stream remains the source for workspace and running-state notifications.

## Installation

Install `@deepseek-ai/dsh-hub-server` through the Harness plugin manager or add its `cordis.patch.yml` row to a profile. The package declares its protocol, session, persistence, and invariant peers; a profile must provide those packages at compatible versions.

## Model Experience

### Session transport

#### What the model sees

None directly. The plugin transports local session operations and events through `hub-server`; the local agent composition remains responsible for model requests.

#### Token effect

None directly; the server does not add prompt content.

#### KV Cache effect

None directly; the server does not change provider request assembly.

## Known Limitations and Deferred Work

- **The listener is a deployment endpoint** — bind address, firewall, TLS, and token distribution must be configured by the deployment.
- **Agent API forwarding requires explicit addressing** — requests must name the owning `endpointId` and `workspaceId`; the listener does not infer an endpoint from a session id or fall back to a local API.
- **Session deletion is not exposed** — the protocol advertises deletion as unsupported until the persistence seam provides a real deletion operation.
