# Agent Note: Hub server forwards the official mux stream

Status: implemented

English | [中文](2026-08-18-hub-server-official-mux-forwarding.zh.md)

## Problem

The Hub server used a process-local `session/event` listener for local session-event forwarding while its Host notifications already came from `api.events.host`. In the assembled Web profile, the Host's official mux stream is the authoritative live source consumed by the client runtime. Using a separate event hook allowed running-state notifications to reach a remote client while user messages and assistant chunks did not.

## Decision

Each authenticated Hub Client receives the local Host's official `api.events.mux` stream. The Hub forwards only `session/event` frames whose session belongs to a known workspace and whose `(workspaceId, sessionId)` matches that Client's subscription. The event payload is forwarded unchanged. The existing `api.events.host` bridge remains responsible for Host-level and workspace-level notifications, and lifecycle status notifications remain separate.

## Alternatives considered

**Keep the process-local `session/event` listener.** Rejected because it is not the assembled Host mux delivery path and can diverge from the stream consumed by the Web runtime.

**Reconstruct user and assistant messages from Host status frames.** Rejected because status frames do not contain the durable event payload or stream sequence, and reconstruction would duplicate Host business logic.

**Use one shared mux stream for all Hub Clients.** Rejected because Client subscription filtering and teardown are connection-owned; one stream per authenticated Client preserves independent lifecycle and authorization state.

## Consequences

Remote Clients see user messages, assistant chunks, and other durable session events through the same event-forwarding path. The Hub opens one Host mux subscription per authenticated Client and aborts it when that Client disconnects or the Hub stops. A test context that supplies `apiProxy` must provide the official mux stream; contexts without `apiProxy` remain usable for non-stream unit tests.
