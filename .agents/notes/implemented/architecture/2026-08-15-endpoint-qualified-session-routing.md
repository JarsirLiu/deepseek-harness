# Agent Note: Endpoint-qualified session routing

Status: implemented

English | [中文](2026-08-15-endpoint-qualified-session-routing.zh.md)

## Problem

The web client can display sessions supplied by more than one endpoint workspace. A bare session id does not identify the owning endpoint or workspace, so a later transport lookup can send a remote operation to the local API, the wrong endpoint, or the wrong workspace on the same endpoint.

## Decision

Remote session ownership is represented by `SessionRef` and indexed with `SessionKey`, which combines the stable endpoint id, selected workspace id, and session id. Remote fork children inherit both the source endpoint and workspace before they enter the client session list. Only workspaces explicitly selected in remote settings are projected into the client runtime. Local sessions retain the `local:default` endpoint and continue to use the local API.

The endpoint id and workspace id are routing metadata owned by the selected remote workspace reference. Session operations must resolve that metadata before selecting a transport; they must not infer ownership from the session id alone or from a path.

## Alternatives considered

**Bare session ids with a UI-owned remote set:** Rejected because the set is transient and cannot distinguish equal ids from different hosts.

**Prefixing ids in the visible session model:** Rejected because the host-generated id remains an opaque wire id and UI identity should not alter it.

## Consequences

The runtime can qualify endpoint and workspace ownership without changing Host session ids. Session caches and workspace mutation surfaces use the same reference; they do not add a second source of ownership metadata.
