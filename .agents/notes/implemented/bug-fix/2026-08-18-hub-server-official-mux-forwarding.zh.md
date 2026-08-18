# Agent Note: Hub server 转发官方 mux 流

Status: implemented

[English](2026-08-18-hub-server-official-mux-forwarding.md) | 中文

## Problem

Hub server 原先使用进程内的 `session/event` listener 转发本地会话事件，而 Host 通知已经来自 `api.events.host`。在组装后的 Web profile 中，Host 官方 mux 流才是客户端 runtime 消费的权威实时来源。两条路径不一致时，运行状态通知可以到达远程客户端，但用户消息和 assistant chunk 不会到达。

## Decision

每个经过认证的 Hub Client 都消费本地 Host 官方的 `api.events.mux` 流。Hub 只转发归属于已知工作区、且其 `(workspaceId, sessionId)` 匹配该 Client 订阅的 `session/event` 帧。事件载荷保持原样转发。现有 `api.events.host` 桥接继续负责 Host 级和工作区级通知，会话生命周期状态通知也保持独立。

## Alternatives considered

**保留进程内 `session/event` listener。** 拒绝，因为它不是组装后 Host 使用的 mux 传递路径，可能与 Web runtime 消费的流产生分歧。

**从 Host 状态帧重建用户消息和 assistant 输出。** 拒绝，因为状态帧不包含持久事件载荷或流序号，重建会重复 Host 业务逻辑。

**所有 Hub Client 共用一条 mux 流。** 拒绝，因为 Client 订阅过滤和销毁属于连接自身；每个认证 Client 一条流可以保持独立的生命周期和授权状态。

## Consequences

远程 Client 通过同一事件转发路径收到用户消息、assistant chunk 和其他持久会话事件。Hub 为每个认证 Client 打开一条 Host mux 订阅，并在 Client 断开或 Hub 停止时 abort。提供 `apiProxy` 的测试上下文必须同时提供官方 mux 流；不提供 `apiProxy` 的上下文仍可用于非流单元测试。
