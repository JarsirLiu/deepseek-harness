# Agent Note: Endpoint-qualified session routing

Status: implemented

## Problem

The web client can display sessions supplied by more than one Harness host. A bare session id does not identify the owning host, so a later transport lookup can send a remote operation to the local API or to the wrong remote endpoint.

## Decision

Remote session ownership is represented by `SessionRef` and indexed with `SessionKey`, which combines the stable endpoint id and session id. Remote fork children inherit the source endpoint before they enter the client session list. Local sessions retain the `local:default` endpoint and continue to use the local API.

The endpoint id is transport metadata owned by the Hub connection. Session operations must resolve that metadata before selecting a transport; they must not infer ownership from the session id alone.

## Alternatives considered

**Bare session ids with a UI-owned remote set:** Rejected because the set is transient and cannot distinguish equal ids from different hosts.

**Prefixing ids in the visible session model:** Rejected because the host-generated id remains an opaque wire id and UI identity should not alter it.

## Consequences

The runtime can qualify endpoint ownership without changing host session ids. The remaining session caches and workspace mutation surfaces must adopt the same reference when they become multi-endpoint aware; they must not add a second source of ownership metadata.
