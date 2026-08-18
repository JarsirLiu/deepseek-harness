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

The same Endpoint may use a different Broker without changing its identity or resource ownership:

```text
Endpoint A ─┐                 ┌── Hub X
Endpoint B ─┼── current ──────┤
Endpoint C ─┘                 └── Hub Y (replacement)
```

The Broker manages Endpoint Agent and Web client connections independently. Authentication identity, endpoint registration, workspace subscriptions, session subscriptions, and event cleanup are scoped to the connection. A client-provided endpoint label is not an authentication identity.

An Endpoint Agent registers its endpoint with the Broker and publishes a complete directory snapshot read from its Host's `workspace.list` and `session.list` APIs. Workspace and session directory frames trigger serial replacement snapshots; a snapshot failure disconnects the Agent so the Broker does not retain stale metadata. The Broker stores endpoint presence and directory metadata, applies access policy, and forwards requests and Host event frames. Session logs, workspaces, models, and other Host state remain owned by the Endpoint.

If the Agent's Hub socket closes unexpectedly, the Agent aborts its Host event stream and clears its registration and directory state. A caller explicitly recovers by calling `connect()` again; that call waits for the old stream to finish, reads a fresh directory snapshot, and registers the new connection. The Agent does not perform background retries.

Any node may run the Broker role alongside its own Host. A single-host deployment remains valid, and a dedicated Broker may run without owning a Host. Multi-endpoint discovery requires the Broker role and an Agent connection from every participating Host. Endpoints reach one another through authorized Host API calls routed by the Broker; the Broker does not provide arbitrary network access between endpoints.

## Replaceable Hubs

The Broker is a replaceable connection facility, not the owner of endpoint resources. An Endpoint can disconnect from one Broker and connect to another without moving or copying its workspaces, sessions, models, or session logs. The new Broker receives a fresh connection authorization and a new directory publication; the Endpoint and its resources retain their identities.

An Endpoint may connect to one or more Brokers when a deployment requires redundancy or separate access domains. A deployment that only requires Hub replacement needs one active Broker connection at a time. Hub federation, automatic failover, and cross-Broker discovery are separate capabilities and are not implied by Endpoint connectivity.

## Registration and Authentication

The Broker uses separate credentials for its roles:

- **Client credential** authenticates a Web client that wants to discover or use endpoints.
- **Enrollment credential** is used once by an Endpoint Agent to register a new endpoint.
- **Endpoint credential** is issued by the Broker and stored by the Agent for later reconnects.

Each Endpoint owns a stable `endpointId`, created locally or assigned by an identity service. Registering with a Broker associates that identity with a Broker-specific connection credential; changing Brokers does not create a new Endpoint identity. An endpoint credential is unique to one Endpoint-to-Broker relationship and is never exposed to the browser. A shared enrollment token is suitable for local development or one-time registration only; it is not a permanent identity for every endpoint.

Registration follows this sequence:

```text
Endpoint Agent -> Broker: register with enrollment credential
Broker -> Endpoint Agent: endpointId + endpoint credential
Endpoint Agent -> Broker: reconnect with endpoint credential
Endpoint Agent -> Broker: publish workspace summaries
Web client -> Broker: authenticate with client credential
Web client -> Broker: list authorized endpoints and workspaces
```

The Broker checks the client identity, Endpoint, resource reference, and API method for every forwarded request. Connecting to the Broker does not grant access to every endpoint or workspace. Endpoint identity and connection authorization are separate: a client may authorize the same Endpoint through a different Broker without changing the Endpoint identity.

## Endpoint Identity

The client owns an endpoint registry. Each remote entry contains its configured URI, credential reference, enabled state, connection status, and the endpoint identity returned by the Hub handshake.

All session, workspace, model, subagent, and event operations use a reference containing the owning `endpointId` and the resource ID. A bare session ID or workspace ID is not a cross-endpoint key. Workspace IDs, session IDs, and subagent IDs are authoritative only within their owning Endpoint.

```ts
type WorkspaceRef = {
  endpointId: string
  workspaceId: string
}

type SessionRef = {
  endpointId: string
  sessionId: string
}
```

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

Hub listener settings belong to the node that runs the Broker:

```yaml
hub.server:
  enabled: false
  host: 127.0.0.1
  port: 8765
  serverName: my-hub
  credentialRef: hub-server-token
```

Endpoint Agent settings belong to the Host that owns the workspaces and sessions it publishes. Remote connection settings and selected remote workspaces belong to the client profile. Changing the Broker changes connection settings and credentials, not ownership of the published resources.

Credentials are stored through the Harness credentials service. Browser local storage stores selected workspace IDs and UI state only; it does not store authentication tokens.

## Settings Page

The Hub settings page has two sections:

- **Remote connections** manages multiple Hub connections, connection tests, enablement, removal, status, and the remote workspaces selected for the home page.
- **This device as Hub** manages the local Hub listener, including enabled state, bind address, port, server name, credentials, lifecycle controls, and the address that other clients can copy.

The small computer icon belongs to the remote connection entry in the settings page. It identifies a configured remote endpoint in that settings section. The home page project list does not use this icon as a project marker.

Selecting a remote workspace in settings publishes a filter containing `(endpointId, workspaceId)`. The home page stores and projects this compound reference, not a bare workspace ID. The home page projects are derived only from that filter and the owning remote Host response. Unselected remote workspaces do not appear in the home page or in an ungrouped section.

Remote paths and working directories describe the owning Host and are never treated as local paths. Remote file, process, model, session, and workspace operations execute on the owning Host through its API. The local client does not pass a remote path to a local shell or filesystem provider.

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

The local Hub service is configured through `hub.server.*` Host operations. `HubServerManager` persists the bind address, port, server name, enabled state, endpoint identity, and credential reference through the settings provider. The browser calls the Host web API for get, update, start, stop, and test operations; it never owns the listener or resolves credentials.

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
