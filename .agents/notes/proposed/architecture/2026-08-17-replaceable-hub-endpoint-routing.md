# Agent Note: Replaceable Hub and Endpoint Routing

Status: proposed

English | [中文](2026-08-17-replaceable-hub-endpoint-routing.zh.md)

## Problem

The multi-endpoint target architecture needs to support any node acting as a Hub while keeping endpoint resources on their owning Hosts. Without explicit ownership and identity rules, replacing a Hub could change resource identity, make local and remote API behavior diverge, or accidentally turn the Hub into a general network proxy.

## Proposal

An Endpoint owns its stable `endpointId`, workspaces, sessions, models, and session logs. A Host may run an Endpoint Agent and a Hub Broker at the same time, while a dedicated Broker may run without a Host. The Broker provides authenticated connection management, endpoint discovery, authorization, request routing, and Host event forwarding; it does not own endpoint resources or expose arbitrary endpoint-to-endpoint networking.

An Endpoint-to-Broker credential authorizes one connection relationship and may be replaced when the Endpoint changes Hubs. A client addresses remote resources with a compound reference containing the owning `endpointId` and resource ID. Local and remote operations use the same Host API contract; only the transport differs. Remote paths, working directories, files, processes, models, sessions, and workspaces are interpreted and executed by the owning Host.

Hub replacement preserves Endpoint and resource identities. Multiple Broker connections, Hub federation, automatic failover, and cross-Broker discovery are separate capabilities and require their own decisions.

## Alternatives considered

**Broker-assigned endpoint identity.** Rejected because changing or replacing a Broker would make a stable Endpoint identity depend on connection infrastructure and could orphan resource references.

**Hub-owned workspace and session state.** Rejected because it duplicates Host business state, complicates replacement, and makes local and remote API behavior different.

**Arbitrary network forwarding between Endpoints.** Rejected because the required capability is authorized Host API access, not a general-purpose network tunnel with a larger security and policy surface.

## Acceptance criteria

- A node can run Host and Hub Broker roles together, and a dedicated Broker can run without a Host.
- Endpoint identity and resource identity remain stable when the Endpoint changes Hubs.
- Every cross-endpoint resource reference contains the owning `endpointId` and the resource ID.
- Broker authorization covers the client, Endpoint, resource, and API method for every forwarded call.
- Remote operations execute on the owning Host through the same API contract used locally.
- The design does not imply Hub federation, automatic failover, or arbitrary network access.

## Risks

Endpoint identity provisioning and authorization across multiple Hubs need explicit storage and lifecycle rules. A client that stores only bare resource IDs can collide across Endpoints, and a client that treats remote paths as local paths can act on the wrong Host. Multi-Hub availability and federation remain unspecified until separate protocol and consistency decisions are made.
