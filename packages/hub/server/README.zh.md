# @deepseek-ai/dsh-hub-server

[English](README.md) | 中文

通过 WebSocket JSON-RPC 暴露本地 Harness 会话的 Cordis 插件。将它安装在持有会话的机器上；远程客户端通过 [`dsh-hub-client`](../client/README.md) 连接。

## 配置

插件 profile row 接受 `port`、`host`、`authTokens` 和 `serverName`。它持有监听服务器，并随插件 fiber 一起释放。schema 中认证 token 可选，但网络暴露与 TLS 仍由部署负责。

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
