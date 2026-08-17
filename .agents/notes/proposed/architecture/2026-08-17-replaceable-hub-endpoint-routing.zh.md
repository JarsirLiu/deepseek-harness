[English](2026-08-17-replaceable-hub-endpoint-routing.md) | 中文

# Agent Note: Replaceable Hub and Endpoint Routing

Status: proposed

## Problem

多端点目标架构需要允许任意节点承担 Hub，同时让端点资源继续归拥有它们的 Host 所有。如果不明确所有权和身份规则，更换 Hub 可能改变资源身份，使本地与远程 API 行为不一致，或意外把 Hub 变成通用网络代理。

## Proposal

Endpoint 持有稳定的 `endpointId`、工作区、会话、模型和会话日志。Host 可以同时运行 Endpoint Agent 与 Hub Broker；也可以运行不拥有 Host 的独立 Broker。Broker 提供认证连接管理、端点发现、授权、请求路由和 Host 事件转发；它不拥有端点资源，也不提供端点之间的任意网络访问。

Agent 的目录权威性记录在 [Endpoint Directory Authority 决策](../../implemented/architecture/2026-08-17-agent-directory-authority.md)中；本提案保留更广泛的拓扑和授权决策。

Endpoint 到 Broker 的凭据只授权一条连接关系；Endpoint 更换 Hub 时可以更换该凭据。客户端使用包含所属 `endpointId` 和资源 ID 的复合引用访问远程资源。本地和远程操作使用同一套 Host API 约定，区别只有传输层。远程路径、工作目录、文件、进程、模型、会话和工作区都由所属 Host 解释并执行。

更换 Hub 不改变 Endpoint 和资源身份。多个 Broker 连接、Hub 联邦、自动故障切换和跨 Broker 发现属于独立能力，需要分别决策。

## Alternatives considered

**由 Broker 分配端点身份。** 不采用，因为更换或替换 Broker 会让稳定的 Endpoint 身份依赖连接设施，并可能使资源引用失效。

**由 Hub 持有工作区和会话状态。** 不采用，因为这会复制 Host 业务状态，增加替换 Hub 的复杂度，并使本地与远程 API 行为不一致。

**在端点之间转发任意网络流量。** 不采用，因为所需能力是受授权控制的 Host API 访问，而不是安全和策略范围更大的通用网络隧道。

## Acceptance criteria

- 一个节点可以同时运行 Host 和 Hub Broker 角色，独立 Broker 可以在不拥有 Host 的情况下运行。
- Endpoint 更换 Hub 时，Endpoint 身份和资源身份保持稳定。
- 每个跨端点资源引用都包含所属 `endpointId` 和资源 ID。
- Broker 对每个转发调用检查客户端、Endpoint、资源和 API 方法的授权。
- 远程操作通过与本地相同的 API 约定，在所属 Host 上执行。
- 该设计不自动承诺 Hub 联邦、自动故障切换或任意网络访问。

## Risks

多 Hub 场景下的 Endpoint 身份分配、存储和授权生命周期仍需明确规则。只保存裸资源 ID 的客户端可能在不同 Endpoint 之间发生冲突，把远程路径当成本地路径处理则可能操作错误的 Host。多 Hub 可用性和联邦能力要等到单独的协议与一致性决策后才能确定。
