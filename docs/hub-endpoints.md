English | [中文](hub-endpoints.zh.md)

# Hub Endpoints and Settings

This reference defines the Hub Broker topology, endpoint registration, discovery authorization, settings ownership, and the browser settings experience for multi-endpoint remote access.

## Topology

A Hub Broker accepts authenticated Endpoint Agents and Web clients. An Endpoint Agent owns one Harness Host. A Web client may connect to multiple Hub Brokers at the same time.

```text
Hub Broker
  ├── Endpoint Agent A
  ├── Endpoint Agent B
  └── Web client connections

Web client
  ├── local endpoint
  ├── remote endpoint A
  └── remote endpoint B
```

The Broker manages Endpoint Agent and Web client connections independently. Authentication identity, endpoint registration, workspace subscriptions, session subscriptions, and event cleanup are scoped to the connection. A client-provided endpoint label is not an authentication identity.

An Endpoint Agent registers its endpoint with the Broker, publishes workspace summaries, and receives API requests for its own Host. The Broker stores endpoint presence and directory metadata, applies access policy, and forwards requests and Host event frames. Session logs, projects, models, and other Host state remain owned by the Endpoint Agent.

The single-host deployment remains valid: a Hub Server can run beside one Host as an Endpoint Agent and accept Web clients. Multi-endpoint discovery requires the Broker role and an Agent connection from every participating Host.

## Registration and Authentication

The Broker uses separate credentials for its roles:

- **Client credential** authenticates a Web client that wants to discover or use endpoints.
- **Enrollment credential** is used once by an Endpoint Agent to register a new endpoint.
- **Endpoint credential** is issued by the Broker and stored by the Agent for later reconnects.

The Broker assigns a stable `endpointId` during registration. An endpoint credential is unique to that endpoint and is never exposed to the browser. A shared enrollment token is suitable for local development or one-time registration only; it is not a permanent identity for every endpoint.

Registration follows this sequence:

```text
Endpoint Agent -> Broker: register with enrollment credential
Broker -> Endpoint Agent: endpointId + endpoint credential
Endpoint Agent -> Broker: reconnect with endpoint credential
Endpoint Agent -> Broker: publish workspace summaries
Web client -> Broker: authenticate with client credential
Web client -> Broker: list authorized endpoints and workspaces
```

The Broker checks the client identity, `endpointId`, `workspaceId`, and API method for every forwarded request. Connecting to the Broker does not grant access to every endpoint or workspace.

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

The discovery flow is:

```text
Web client -> list-endpoints
Web client -> list-workspaces(endpointId)
Web client -> select (endpointId, workspaceId)
Web client -> Host API through the selected endpoint
```

## Server Lifecycle

`HubServerManager` owns listener lifecycle. A settings update is validated before it is applied. Changes to the bind address or port stop the old listener, close its client connections, and start a listener with the new configuration. If the new listener cannot start, the manager reports the error and retains the previous running configuration.

The server requires authentication before accepting non-loopback access. The settings page displays the connection address and a redacted credential state, never the stored token value.

An externally reachable Broker must bind to a reachable interface, use an allowed firewall and proxy route, and expose a TLS endpoint in production. The advertised connection address must be the address other endpoints can reach, not an internal `127.0.0.1` listener address. Non-loopback access is rejected without authentication.

## Package Responsibilities

- `hub/protocol` defines wire types and transport messages.
- `hub/server` owns the Broker listener, authentication, Endpoint Agent registry, Web client registry, access policy, and Host API forwarding.
- `hub/client` owns one remote endpoint transport or Endpoint Agent connection.
- `hub/web-adapter` resolves endpoint transports for the Web runtime.
- `client/ui-hub` renders settings and invokes the endpoint and server control services.

The UI package does not open sockets, start listeners, persist credentials, or implement session operations. It invokes the settings and discovery services supplied by the Hub plugins.

## Verification

The multi-endpoint test matrix covers endpoint enrollment, endpoint credential rotation, duplicate session IDs across endpoints, independent client subscriptions, endpoint removal, connection failure, listener restart failure, discovery authorization, selected-workspace filtering, externally reachable address configuration, and settings persistence without credential leakage.
