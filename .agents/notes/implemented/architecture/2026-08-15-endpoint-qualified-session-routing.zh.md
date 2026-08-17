# Agent Note: Endpoint-qualified session routing

Status: implemented

[English](2026-08-15-endpoint-qualified-session-routing.md) | 中文

## Problem

Web 客户端可以同时显示多个 Harness 主机提供的会话。单独的会话 ID 不能标识所属主机，因此后续传输可能把远程操作发送到本地 API 或错误的远程端点。

## Decision

远程会话使用 `SessionRef` 表示所有权，并使用组合端点 ID 与会话 ID 的 `SessionKey` 建立索引。远程 fork 子会话在进入客户端会话列表前继承源端点。本地会话保留 `local:default` 端点并继续使用本地 API。

端点 ID 由 Hub 连接持有的传输元数据提供。会话操作必须先解析该元数据再选择传输，不能仅根据会话 ID 推断所有权。

## Alternatives considered

**使用裸会话 ID 和 UI 自己维护远程集合：** 放弃，因为集合是临时状态，并且无法区分不同主机产生的相同 ID。

**在可见会话模型中给 ID 加前缀：** 放弃，因为主机生成的 ID 仍是不可解释的线缆 ID，UI 身份不应修改它。

## Consequences

运行时可以在不改变主机会话 ID 的前提下区分端点所有权。剩余会话缓存和工作区变更接口在支持多端点时必须使用同一个引用，不能再增加第二套所有权元数据来源。
