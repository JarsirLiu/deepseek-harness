# @deepseek-ai/dsh-hub-client

[English](README.md) | 中文

连接远程 Hub server 并通过 Harness session provider 与 Agent command 提供其会话和远程执行能力的 Cordis 插件。将它安装在运行浏览器或其他客户端应用的机器上；可选的 [`dsh-client-ui-hub`](../../client/ui-hub/README.md) 用于展示连接状态。

## 配置

插件 profile row 持有远程 WebSocket URI 与认证设置。客户端不能配置远程端点身份；成功的 Hub 握手是身份的唯一来源。握手完成前，`/api/hub/status` 返回 `endpointId: null`，也不会注册远程传输。插件注册远程 session provider，并提供可选 UI 包使用的 `/api/hub/status` Web 端点；插件 fiber 释放时连接一并释放。

本包还导出 `HubEndpointAgent`，供 Host 向 Hub listener 注册自身。Agent 必须使用显式端点身份、注册 token、Host `apiProxy` 和完整工作区目录。它只接受寻址到自身端点及已发布工作区的 API 请求，并返回原始 Host API 结果，不将结果投影为 Hub 专用模型。

注册完成后，Agent 消费与本地客户端相同的 Host `api.events.host` 流。它根据已发布的目录确定每帧所属工作区，通过 Hub 转发未修改的帧，并在断连时 abort 且等待流结束。端点级帧使用 `workspaceId: null`；无法唯一确定项目归属的项目帧会终止桥接，而不会产生歧义广播。

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

- **UI 为可选项**：只安装 client provider 仍可提供远程会话，但不会出现设置区。
- **Web 路由由部署负责** —— `RemoteAgentClient` 提供远程执行接口；Host API 必须为配置为远程执行的会话选择它。
- **Endpoint Agent 发布必须显式提供**：Host 集成必须向 `HubEndpointAgent` 提供工作区摘要；本包不会推导或合成目录。
