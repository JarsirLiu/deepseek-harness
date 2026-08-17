# @deepseek-ai/dsh-hub-server

[English](README.md) | 中文

通过 WebSocket JSON-RPC 暴露本地 Harness 会话的 Cordis 插件。将它安装在持有会话的机器上；远程客户端通过 [`dsh-hub-client`](../client/README.md) 连接。

## 配置

插件 profile row 必须提供稳定的 `endpointId`，并接受 `port`、`host`、`authTokens`、`agentTokens` 和 `serverName`。`endpointId` 由拥有所发布会话的 Host 持有，在握手时返回；它不会从客户端配置或 `serverName` 推导。`agentTokens` 将稳定的 Endpoint Agent 身份映射到显式注册凭据。已注册 Agent 通过同一个 listener 发布工作区摘要，经过认证的 Client 使用 `hub/list-endpoints` 发现这些端点。插件持有监听服务器，并随插件 fiber 一起释放。默认只监听回环地址；只有配置认证并保护传输时才应指定非回环地址。

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
- **暂不转发 Agent API**：本阶段只注册 Agent 并发布工作区摘要；已注册端点的会话与 Host API 转发属于独立能力。
- **不提供会话删除**：在 persistence seam 提供真正的删除操作前，协议将删除声明为不支持。
