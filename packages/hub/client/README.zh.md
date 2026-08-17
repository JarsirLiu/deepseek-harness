# @deepseek-ai/dsh-hub-client

[English](README.md) | 中文

连接远程 Hub server 并通过 Harness session provider 与 Agent command 提供其会话和远程执行能力的 Cordis 插件。将它安装在运行浏览器或其他客户端应用的机器上；可选的 [`dsh-client-ui-hub`](../../client/ui-hub/README.md) 用于展示连接状态。

## 配置

插件 profile row 持有远程 WebSocket URI 与认证设置。客户端不能配置远程端点身份；成功的 Hub 握手是身份的唯一来源。握手完成前，`/api/hub/status` 返回 `endpointId: null`，也不会注册远程传输。插件注册远程 session provider，并提供可选 UI 包使用的 `/api/hub/status` Web 端点；插件 fiber 释放时连接一并释放。

本包还导出 `HubEndpointAgent`，供 Host 向 Hub listener 注册自身。Agent 必须使用显式端点身份、注册 token、Host `apiProxy` 和 `HubWorkspaceDirectoryProvider`。该 provider 从本端 Host 的完整 `workspace.list` 与 `session.list` 快照读取目录；Agent 在注册时发布快照，并在工作区或会话目录变化后串行替换已发布目录。

注册完成后，Agent 消费与本地客户端相同的 Host `api.events.host` 流。它根据已发布的目录确定每帧所属工作区，通过 Hub 转发未修改的帧，并在断连时 abort 且等待流结束。端点级帧使用 `workspaceId: null`；无法唯一确定项目归属的项目帧会终止桥接，而不会产生歧义广播。目录快照失败会关闭 Agent 连接，Hub 不会继续公布旧目录元数据。

Hub socket 意外关闭时，Agent 会中止 Host 流并清除注册和目录状态。调用方再次调用 `connect()` 即执行显式恢复：Agent 等待旧流结束，重新读取权威目录快照，并注册新的 Hub 连接。Agent 不会在后台自动重试或重连。

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
- **目录权威性在本端**：Agent 从所属 Host 的 `workspace.list` 与 `session.list` 生成发现目录，不根据单个 Host 帧拼凑摘要。
- **发现与投影分离**：新发现的工作区只会成为设置页中的可选候选；客户端首页只有在用户选择其 `(endpointId, workspaceId)` 引用后才会显示。
