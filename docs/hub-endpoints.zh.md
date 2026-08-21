[English](hub-endpoints.md) | 中文

# Hub 端点与设置

本文定义 Hub Broker 拓扑、端点注册、发现权限、设置归属，以及多端点远程访问的浏览器设置体验。

## 拓扑

一个 Hub 接受经过认证的 Endpoint Agent 和 Client。每个 Endpoint Agent 拥有一个 Harness Host。任意 Harness 节点都可以同时运行 Hub、Agent 和 Client 角色。一个 Client 可以同时连接多个 Hub。

```text
Hub
  ├── Endpoint Agent A
  ├── Endpoint Agent B
  └── Client connections

Node
  ├── optional Hub listener
  ├── optional Endpoint Agent registration
  └── optional Client connection
```

同一个 Endpoint 可以改用另一个 Broker，而不改变自身身份或资源所有权：

```text
Endpoint A ─┐                 ┌── Hub X
Endpoint B ─┼── current ──────┤
Endpoint C ─┘                 └── Hub Y (replacement)
```

Broker 独立管理每个 Endpoint Agent 和 Web 客户端连接。认证身份、端点注册、工作区订阅、会话订阅和事件清理都以连接为作用域。客户端提供的端点标签不是认证身份。

Endpoint Agent 向 Broker 注册端点，并从本端 Host 的 `workspace.list` 与 `session.list` API 读取完整目录快照后发布。工作区或会话目录事件会触发串行快照替换；快照失败会断开 Agent，Broker 不会继续保留旧目录元数据。Broker 保存端点在线状态和目录元数据，执行访问策略，并转发请求和 Host 事件帧。会话日志、工作区、模型和其他 Host 状态仍由 Endpoint 持有。

如果 Agent 的 Hub socket 意外关闭，Agent 会中止 Host 事件流，并清除注册和目录状态。调用方再次调用 `connect()` 执行显式恢复；该调用会等待旧流结束，重新读取目录快照，并注册新的连接。Agent 不会在后台自动重试。

任意节点都可以在运行自身 Host 的同时承担 Hub、Agent 和 Client 角色。拥有 Hub 本地 Host 资源的节点不需要把这些资源重复注册为同一个 Hub 的 Agent；Hub 会直接公布本地工作区目录。希望通过其他 Hub 暴露自身资源的节点，导入该 Hub 的连接凭据并建立 Agent 注册。端点之间通过 Hub 路由、并受授权控制的 Host API 调用互通；Hub 不提供端点之间的任意网络访问。

## Hub 可替换性

Broker 是可替换的连接设施，不是端点资源的所有者。Endpoint 可以断开当前 Broker 并连接另一个 Broker，而不移动或复制其工作区、会话、模型或会话日志。新的 Broker 会获得新的连接授权并重新接收目录发布；Endpoint 及其资源继续使用原有身份。

在需要冗余或独立访问域的部署中，一个 Endpoint 可以连接一个或多个 Broker。只需要替换 Hub 的部署，一次保持一个活动 Broker 连接即可。Hub 联邦、自动故障切换和跨 Broker 发现属于独立能力，不能从 Endpoint 连接关系中推导出来。

## 注册与认证

Hub 设置页面为 Hub 生成一份连接凭据。凭据包含 Hub URI、Hub 身份和 Hub token。节点可以用同一份凭据承担两种角色：Client 连接用于认证发现和 API 请求，Endpoint Agent 连接用于注册本节点的 Host。凭据通过 Host 的 credentials service 保存，绝不会写入浏览器存储。

Hub token 授权注册握手，注册节点则提供自己的稳定 `endpointId`。Hub 身份与每个已注册 Agent 身份必须不同。复用 Hub 的 `endpointId`、接受浏览器提供的端点身份，或从标签推导端点身份都不合法。更换 Hub 不会改变 Agent 身份。

注册流程如下：

```text
Hub -> node: connection credential
Endpoint Agent -> Hub: register(endpointId, token, serverInfo, workspace snapshot)
Hub -> Client or Agent: authenticated connection
Endpoint Agent -> Hub: replace workspace snapshot and forward official Host events
Client -> Hub: list authorized endpoints and workspaces
Client -> Hub: forward the same Host API requests to the selected endpoint
```

Broker 对每个转发请求检查客户端身份、Endpoint、资源引用和 API 方法。连接 Broker 不会自动获得所有端点或工作区的访问权限。Endpoint 身份与连接授权彼此独立：客户端可以通过另一个 Broker 授权访问同一个 Endpoint，而不改变 Endpoint 身份。

## 端点身份

客户端拥有端点注册表。每个远程条目包含配置的 URI、凭据引用、启用状态、连接状态，以及 Hub 握手返回的端点身份。

所有会话、工作区、模型、子会话和事件操作都使用包含所属 `endpointId` 与资源 ID 的引用。裸会话 ID 或工作区 ID 不能作为跨端点键。工作区 ID、会话 ID 和子会话 ID 只在所属 Endpoint 内具有权威性。

```ts
type WorkspaceRef = {
  endpointId: string
  workspaceId: string
}

type SessionRef = {
  endpointId: string
  sessionId: string
}
```

本地端点使用正常的 Host API 传输层。远程端点通过 Hub 传输层使用同一套 API 约定。Hub 只转发请求和 Host 事件帧，不维护第二套会话业务模型。

## 设置归属

远程 Hub 连接设置属于节点 profile：

```yaml
hub.endpoints:
  - id: remote:office
    label: Office computer
    uri: ws://192.168.1.20:8765/hub
    credentialRef: hub-token-office
    enabled: true
    registerAgent: true
```

Hub listener 设置属于运行 Broker 的节点：

```yaml
hub.server:
  enabled: false
  host: 127.0.0.1
  port: 8765
  serverName: my-hub
  credentialRef: hub-server-token
```

`registerAgent: true` 让节点通过该 Hub 注册自己的 Host。`agentEndpointId` 是节点拥有的稳定身份，并保存在同一个设置命名空间中。节点可以在保留 Client 连接的同时关闭 Agent 注册。更换 Hub 只改变连接和凭据，不改变已发布资源的所有权。

凭据通过 Harness credentials 服务保存。浏览器 localStorage 只保存已选择的工作区 ID 和界面状态，不保存认证 Token。

## 设置页面

Hub 设置页包含三个职责：

- **Hub 连接**管理多个 Hub 连接、连接测试、启用状态、删除、连接状态、是否注册本地 Agent，以及加载到首页的远程工作区。
- **本机作为 Hub**管理本机 Hub listener，包括启用状态、监听地址、端口、服务名称、凭据、生命周期控制，以及供其他客户端复制的连接地址。
- **本机身份**管理节点注册到其他 Hub 时使用的稳定 `agentEndpointId`。

小电脑图标只属于设置页面中的远程连接入口和远程端点条目，用于标识已配置的远程端点。首页项目列表不使用这个图标作为项目标记。

在设置中选择远程工作区后，客户端发布由 `(endpointId, workspaceId)` 组成的过滤条件。首页保存并投影这个复合引用，而不是单独的工作区 ID。首页项目只根据该过滤条件和所属远程 Host 返回的数据生成。未选择的远程工作区不会出现在首页，也不会进入未分组区域。

远程路径和工作目录描述的是所属 Host 的位置，不能当作本地路径处理。远程文件、进程、模型、会话和工作区操作都通过 API 在所属 Host 执行。本地客户端不会把远程路径传给本地 shell 或文件系统 provider。

发现与注册流程如下：

```text
Hub -> issue connection credential
Node -> import credential and optionally register its Agent
Hub -> publish local and registered endpoint directories
Client -> list-endpoints and list-workspaces
Client -> select (endpointId, workspaceId)
Client -> Host API through the selected endpoint
```

## 服务端生命周期

`HubServerManager` 负责 listener 生命周期。设置更新必须先完成校验再应用。监听地址或端口变化时，管理器停止旧 listener、关闭其客户端连接，并使用新配置启动 listener。如果新 listener 无法启动，管理器报告错误并保留之前正在运行的配置。

服务端在接受非回环访问前必须完成认证。设置页面显示连接地址和脱敏后的凭据状态，不显示保存的 Token 值。

本机 Hub 服务通过 `hub.server.*` Host 操作配置。`HubServerManager` 使用设置服务持久化监听地址、端口、服务名称、启用状态、端点身份和凭据引用。浏览器通过 Host Web API 获取、更新、启动、停止和测试服务，不直接拥有监听器，也不解析凭据。

可被外部访问的 Broker 必须监听可达网卡，配置防火墙和代理转发，并在生产环境提供 TLS 端点。对外公布的连接地址必须是其他端点能够访问的地址，不能是内部的 `127.0.0.1` 监听地址。没有认证时拒绝非回环访问。

## 包职责

- `hub/protocol` 定义 wire 类型和传输消息。
- `hub/server` 负责 Broker listener、认证、Endpoint Agent 注册表、Web 客户端注册表、访问策略和 Host API 转发。
- `hub/client` 负责一个远程端点传输层或 Endpoint Agent 连接。
- `hub/web-adapter` 为 Web runtime 解析端点传输层。
- `client/ui-hub` 渲染设置页并调用端点和服务端控制服务。

UI 包不打开 socket、不启动 listener、不持久化凭据，也不实现会话操作。它调用 Hub 插件提供的设置和发现服务。

## 验证

多端点测试矩阵覆盖端点注册、端点凭据轮换、不同端点的重复会话 ID、独立客户端订阅、端点删除、连接失败、listener 重启失败、发现权限、已选工作区过滤、对外可达地址配置，以及设置持久化时不泄露凭据。
