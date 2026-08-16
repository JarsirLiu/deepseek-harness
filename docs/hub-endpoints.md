English | [中文](hub-endpoints.zh.md)

# Hub Endpoints and Settings

This reference defines the Hub topology, endpoint identity, settings ownership, and the browser settings experience for multi-endpoint remote access.

## Topology

A Hub server owns one Harness host and accepts connections from multiple clients. A client may connect to multiple Hub servers at the same time.

```text
Hub server
  ├── client connection A
  ├── client connection B
  └── client connection C

Web client
  ├── local endpoint
  ├── remote endpoint A
  └── remote endpoint B
```

The server manages each client connection independently. Authentication identity, workspace subscriptions, session subscriptions, and event cleanup are scoped to the connection. A client-provided endpoint label is not an authentication identity.

## Endpoint Identity

The client owns an endpoint registry. Each remote entry contains its configured URI, credential reference, enabled state, connection status, and the endpoint identity returned by the Hub handshake.

```ts
type SessionRef = {
  endpointId: string
  sessionId: SessionId
}
```

All session, workspace, model, subagent, and event operations resolve a transport from `endpointId`. A bare session ID is not a cross-endpoint key.

The local endpoint uses the normal Host API transport. A remote endpoint uses the same API contract through the Hub transport. The Hub forwards requests and Host event frames; it does not maintain a second session business model.

## Settings Ownership

Remote client settings belong to the client profile:

```yaml
hub.endpoints:
  - id: remote:office
    label: Office computer
    uri: ws://192.168.1.20:8765/hub
    credentialRef: hub-token-office
    enabled: true
```

Hub server settings belong to the host that publishes its sessions:

```yaml
hub.server:
  enabled: false
  host: 127.0.0.1
  port: 8765
  serverName: my-hub
  credentialRef: hub-server-token
```

Credentials are stored through the Harness credentials service. Browser local storage stores selected workspace IDs and UI state only; it does not store authentication tokens.

## Settings Page

The Hub settings page has two sections:

- **Remote connections** manages multiple Hub endpoints, connection tests, enablement, removal, status, and the remote workspaces selected for the home page.
- **This device as Hub** manages the local Hub listener, including enabled state, bind address, port, server name, credentials, lifecycle controls, and the address that other clients can copy.

The small computer icon belongs to the remote connection entry in the settings page. It identifies a configured remote endpoint in that settings section. The home page project list does not use this icon as a project marker.

Selecting a remote workspace in settings publishes a filter containing `(endpointId, workspaceId)`. The home page projects are derived only from that filter and the owning remote Host response. Unselected remote workspaces do not appear in the home page or in an ungrouped section.

## Server Lifecycle

`HubServerManager` owns listener lifecycle. A settings update is validated before it is applied. Changes to the bind address or port stop the old listener, close its client connections, and start a listener with the new configuration. If the new listener cannot start, the manager reports the error and retains the previous running configuration.

The server requires authentication before accepting non-loopback access. The settings page displays the connection address and a redacted credential state, never the stored token value.

## Package Responsibilities

- `hub/protocol` defines wire types and transport messages.
- `hub/server` owns the listener, authentication, client registry, and Host API forwarding.
- `hub/client` owns one remote endpoint transport.
- `hub/web-adapter` resolves endpoint transports for the Web runtime.
- `client/ui-hub` renders settings and invokes the endpoint and server control services.

The UI package does not open sockets, start listeners, persist credentials, or implement session operations.

## Verification

The multi-endpoint test matrix covers duplicate session IDs across endpoints, independent client subscriptions, endpoint removal, connection failure, listener restart failure, selected-workspace filtering, and settings persistence without credential leakage.
