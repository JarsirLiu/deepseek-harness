# @deepseek-ai/dsh-hub-client

English | [中文](README.zh.md)

Cordis plugin that connects to a remote Hub server and exposes its sessions and Agent commands through the Harness client. Install it on the machine running the browser or another client application; the optional [`dsh-client-ui-hub`](../../client/ui-hub/README.md) package displays its connection status.

## Configuration

The plugin profile row owns the remote WebSocket URI and authentication settings. It registers the remote session provider and the `/api/hub/status` web endpoint used by the optional UI package. It disposes the connection with the plugin fiber.

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
