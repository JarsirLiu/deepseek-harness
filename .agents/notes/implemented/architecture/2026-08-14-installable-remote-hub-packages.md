# Agent Note: Publish remote Hub capabilities as independent packages

Status: implemented

English | [中文](2026-08-14-installable-remote-hub-packages.zh.md)

## Problem

Remote Hub support spans a wire protocol, a server-side provider, a client-side provider, and an optional browser settings section. A consumer must be able to install only the roles needed by its deployment while the Harness profile still composes compatible roles without application-specific imports.

## Decision

The Hub capability is published as three installable runtime packages and one optional UI package:

- `@deepseek-ai/dsh-hub-protocol` publishes shared transport and response types as a library and has no Cordis row.
- `@deepseek-ai/dsh-hub-server` publishes a Cordis plugin and bundle patch that exposes local sessions and Agent execution over WebSocket JSON-RPC.
- `@deepseek-ai/dsh-hub-client` publishes a Cordis plugin and bundle patch that connects to a Hub server, exposes the remote session provider, and supplies remote Agent commands and event notifications to the Host API.
- `@deepseek-ai/dsh-client-ui-hub` publishes the browser settings section. It registers through `settings.section`, depends on injected slot/runtime/locale services, and treats a missing `/api/hub/status` endpoint as an explicit unavailable result. It does not own Hub transport or persistence.

Each package declares its published entrypoints, bundled files, peer dependencies, and repository directory in `package.json`. The web bundle declares the UI package dependency and `dsh.client` row, while the server and client packages declare their own bundle patches. This keeps package installation and profile composition explicit.

## Alternatives considered

- **Publish one monolithic Hub package** — rejected because a server deployment should not install browser presentation and a thin client should not install server-only code.
- **Let the UI component call the Hub service directly** — rejected because presentation components must receive business operations through slot injection; transport ownership stays in the host plugin.
- **Treat every failed status response as disconnected** — rejected because an unavailable endpoint and a configured endpoint failure have different deployment meanings and must remain distinguishable.

## Consequences

Consumers can install protocol, server, client, and UI roles independently, with the profile manifest expressing the valid composition edges. The Host API uses an installed hub client as the remote prompt and event carrier, while the UI package remains inert and explicit when its host endpoint is absent. Cross-package compatibility is tied to the shared workspace version range and the protocol response types; independent publication still requires releasing compatible package versions together when the wire contract changes.

## Verification

The UI component suite covers loading, all connection states, unavailable endpoint, error detail, and retry behavior. TypeScript project references validate the protocol, server, client, and Host API entrypoints and declared dependency graph. The remote Agent path still requires a real two-process WebSocket integration test before publication.
