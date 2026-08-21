# @deepseek-ai/dsh-hub-server

[English](README.md) | 中文

通过 WebSocket JSON-RPC 暴露本地 Harness 会话的 Cordis 插件。将它安装在持有会话的机器上；远程客户端通过 [`dsh-hub-client`](../client/README.md) 连接。

## 配置

插件 profile row 必须提供稳定的 `endpointId`，并接受 `port`、`host`、`authTokens`、`agentTokens` 和 `serverName`。`endpointId` 由拥有 Hub listener 的 Host 持有，在握手时返回；它不会从客户端配置或 `serverName` 推导。Hub 的 `authTokens` 同时授权 Client 握手和 Endpoint Agent 注册；`agentTokens` 可以为指定的 Agent 身份替换这份共享授权。已注册 Agent 通过同一个 listener 发布工作区摘要，经过认证的 Client 使用 `hub/list-endpoints` 或 `hub/workspaces` 发现这些资源。workspace 条目保留所属 `endpointId`，因此不同端点上同名的 workspace 仍然彼此独立。API 请求同时携带 `endpointId` 和 `workspaceId`；server 校验已发布的工作区，将注册端点的请求转发给所属 Agent，并返回 Agent 的原始 API 结果。插件持有监听服务器，并随插件 fiber 一起释放。默认只监听回环地址；只有配置认证并保护传输时才应指定非回环地址。

本地会话事件来自 Host 官方的 `api.events.mux` 流。Hub 不重写用户消息或 assistant 输出，而是保留每个 `session/event`，仅发送给订阅所属会话的 Client。Host 的 `api.events.host` 流仍然负责工作区和运行状态通知。

## 安装

通过 Harness plugin manager 安装 `@deepseek-ai/dsh-hub-server`，或将其 `cordis.patch.yml` row 加入 profile。本包声明 protocol、session、persistence 和 invariant peer；profile 必须提供兼容版本的这些包。

## Model Experience

### 会话传输

#### What the model sees

无直接影响。插件通过 `hub-server` 传输本地会话操作与事件；本地 agent 组合仍负责模型请求。

#### Token effect

无直接影响；server 不添加 prompt 内容。

#### KV Cache effect

无直接影响；server 不改变 provider 请求组装。

## 已知限制与后续工作

- **监听器是部署端点**：绑定地址、防火墙、TLS 和 token 分发必须由部署配置。
- **Agent API 转发要求显式寻址**：请求必须指定所属 `endpointId` 和 `workspaceId`；listener 不从 session id 推断端点，也不会回退到本地 API。
- **不提供会话删除**：在 persistence seam 提供真正的删除操作前，协议将删除声明为不支持。
