# Hub Packages

English | [中文](README.zh.md)

The remote Hub capability is split into independently publishable packages. Install only the roles required by a deployment and compose them through the Harness profile.

## Packages

- [`protocol/`](protocol/): shared WebSocket JSON-RPC types and transport helpers; library only.
- [`server/`](server/): Cordis plugin that exposes local sessions to remote clients.
- [`client/`](client/): Cordis plugin that consumes a remote Hub as a session provider.
- [`../client/ui-hub/`](../client/ui-hub/): optional browser settings section for Hub status.

The server and client packages include bundle patches for profile installation. The protocol package has no Cordis row and is installed as a dependency of the runtime roles.

## Topology

The server owns local sessions and accepts WebSocket JSON-RPC connections. The client connects to one server and presents its remote sessions through the Harness session capability. The UI package is independent of the transport and reads the client status endpoint through the web host.

## Installation

Install the server or client package with the Harness plugin manager, then enable its profile row and configure its package-owned fields in the profile patch. The exact configuration and required peer packages are documented by each package README.

## Model Experience

The Hub packages do not add model-visible inputs. They transport or render session state; the session package remains responsible for the durable log and model transcript.

#### KV Cache effect

None directly; Hub transport does not assemble provider requests.

## Known Limitations and Deferred Work

- **Compatible releases are required** — a wire protocol change must be released with compatible server, client, and protocol versions.
- **Authentication is deployment-owned** — network exposure, TLS termination, and credential distribution remain outside these packages.
