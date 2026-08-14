# @deepseek-ai/dsh-hub-client

[English](README.md) | 中文

连接远程 Hub server 并通过 Harness session provider 与 Agent command 提供其会话和远程执行能力的 Cordis 插件。将它安装在运行浏览器或其他客户端应用的机器上；可选的 [`dsh-client-ui-hub`](../../client/ui-hub/README.md) 用于展示连接状态。

## 配置

插件 profile row 持有远程 WebSocket URI 与认证设置。它注册远程 session provider，并提供可选 UI 包使用的 `/api/hub/status` Web 端点。插件 fiber 释放时连接一并释放。

## 安装

通过 Harness plugin manager 安装 `@deepseek-ai/dsh-hub-client`，或将其 `cordis.patch.yml` row 加入 profile。本包声明 protocol、session、persistence 和 invariant peer；profile 必须提供兼容版本的这些包。

## Model Experience

### 远程会话 provider

#### What the model sees

间接影响。远程会话事件与历史由正常 Harness session 和 agent 组合通过 `SessionPersistence` 消费，因此模型看到的 session-visible 输入与本地 provider 相同。

#### Token effect

无额外 token 影响；prompt 组装由 session 组合负责。

#### KV Cache effect

无额外影响；provider 请求组装与缓存行为由 session 组合负责。

## 已知限制与后续工作

- **Web 路由由部署负责** —— `RemoteAgentClient` 提供远程执行接口；Host API 必须为配置为远程执行的会话选择它。

## 已知限制与后续工作

- **UI 为可选项**：只安装 client provider 仍可提供远程会话，但不会出现设置区。
