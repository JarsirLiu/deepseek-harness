# @deepseek-ai/dsh-hub-server

English | [中文](README.zh.md)

Cordis plugin that exposes local Harness sessions over WebSocket JSON-RPC. Install it on the machine that owns the sessions; remote clients use [`dsh-hub-client`](../client/README.md) to connect.

## Configuration

The plugin accepts `port`, `host`, `authTokens`, and `serverName` in its profile row. It owns the listening server and disposes it with the plugin fiber. Authentication tokens are optional in the schema but network exposure and TLS remain deployment responsibilities.

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
