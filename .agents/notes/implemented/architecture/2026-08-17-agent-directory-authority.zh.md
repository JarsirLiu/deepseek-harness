# Agent Note: Endpoint Directory Authority

Status: implemented

English | [English](2026-08-17-agent-directory-authority.md)

## Problem

Endpoint Agent 可以转发实时 Host 帧，但 Broker 中的目录仍可能是注册时的旧快照，导致发现结果出现本端 Host 已不存在的项目或会话摘要。

## Decision

`HubWorkspaceDirectoryProvider` 从所属 Host 的 `workspace.list` 与 `session.list` 读取完整响应，并组合为 `HubEndpointAgent` 发布的目录。注册使用该 provider，工作区或会话生命周期帧触发串行的完整快照替换。Agent 原样转发 Host 帧，只使用目录确定归属。快照或发布失败会关闭 Agent 连接，让 Broker 移除旧目录。Hub socket 意外关闭时，Agent 会中止 Host 流并清除注册和目录状态；之后显式调用 `connect()` 会等待流结束，重新读取快照并再次注册。目录发布只影响发现候选项目；客户端首页仍只有在用户显式选择 `(endpointId, workspaceId)` 后才投影远程工作区。

这实现了[可替换 Hub 与 Endpoint 路由提案](../../proposed/architecture/2026-08-17-replaceable-hub-endpoint-routing.md)中的目录权威性部分。

## Alternatives considered

**根据单个 Host 帧拼凑摘要。**不采用，因为帧不包含目录所需的全部字段，包括会话标题、更新时间、完整运行状态和归属状态。

**快照失败后继续运行。**不采用，因为实时事件流与旧发现目录同时存在是不合法状态，会掩盖权威来源已经不可用。

**自动投影新发现的工作区。**不采用，因为发现和用户首页选择是两种独立状态；自动投影会改变设置中的显式选择约定。

## Consequences

Endpoint 集成必须向 provider 提供完整 Host API，相关生命周期事件会触发两次 unary 读取。串行处理保证较旧快照不会在较新快照之后发布。Broker 仍是路由器和目录缓存，不会变成第二个工作区或会话权威来源。Agent 不会在后台自动尝试重连；连接关闭后的恢复时机由调用方负责，可以显式再次调用 `connect()`。
