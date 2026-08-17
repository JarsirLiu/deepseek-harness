# Agent Note: Endpoint Directory Authority

Status: implemented

English | [中文](2026-08-17-agent-directory-authority.zh.md)

## Problem

An Endpoint Agent can forward live Host frames while its Broker directory remains an old registration snapshot. Discovery then offers projects or session summaries that no longer exist on the owning Host.

## Decision

`HubWorkspaceDirectoryProvider` reads `workspace.list` and `session.list` from the owning Host and combines those complete responses into the directory published by `HubEndpointAgent`. Registration uses this provider, and workspace or session lifecycle frames trigger serial full-snapshot replacement. The Agent forwards unchanged Host frames and uses the directory only to determine ownership. A snapshot or publication failure closes the Agent connection, removing the stale directory from the Broker. An unexpected Hub socket close aborts the Host stream and clears registration and directory state; a later explicit `connect()` waits for stream teardown, reads a fresh snapshot, and registers again. Directory publication affects discovery candidates only; the client still projects a remote workspace on its homepage only after explicit selection of `(endpointId, workspaceId)`.

This implements the directory-authority portion of the [replaceable Hub and Endpoint routing proposal](../../proposed/architecture/2026-08-17-replaceable-hub-endpoint-routing.md).

## Alternatives considered

**Assembling summaries from individual Host frames.** Rejected because frames do not carry all directory fields, including session title, update time, and complete running or membership state.

**Continuing after a snapshot failure.** Rejected because a live event stream paired with stale discovery metadata is an invalid state that hides loss of authority.

**Automatically projecting newly discovered workspaces.** Rejected because discovery and the user's homepage selection are separate state; automatic projection would change the explicit settings contract.

## Consequences

The Endpoint integration must expose the complete Host API to the provider, and directory refreshes perform two unary reads per relevant lifecycle event. Serial processing prevents an older snapshot from being published after a newer one. The Broker remains a router and directory cache; it does not become a second workspace or session authority.
The Agent does not perform background reconnect attempts; callers own recovery timing and may explicitly call `connect()` after a connection has closed.
