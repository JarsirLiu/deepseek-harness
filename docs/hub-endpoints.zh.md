[English](hub-endpoints.md) | 中文

# Hub 端点与设置

本文定义 Hub 拓扑、端点身份、设置归属，以及多端点远程访问的浏览器设置体验。

## 拓扑

一个 Hub 服务端拥有一个 Harness Host，并接受多个客户端连接。一个客户端可以同时连接多个 Hub 服务端。

```text
Hub server
  ├── client connection A
  ├── client connection B
  └── client connection C

Web client
  ├── local endpoint
  ├── remote endpoint A
  └── remote endpoint B
```

服务端独立管理每个客户端连接。认证身份、工作区订阅、会话订阅和事件清理都以连接为作用域。客户端提供的端点标签不是认证身份。

## 端点身份

客户端拥有端点注册表。每个远程条目包含配置的 URI、凭据引用、启用状态、连接状态，以及 Hub 握手返回的端点身份。

```ts
type SessionRef = {
  endpointId: string
  sessionId: SessionId
}
```

所有会话、工作区、模型、子会话和事件操作都根据 `endpointId` 解析传输层。裸会话 ID 不能作为跨端点键。

本地端点使用正常的 Host API 传输层。远程端点通过 Hub 传输层使用同一套 API 约定。Hub 只转发请求和 Host 事件帧，不维护第二套会话业务模型。

## 设置归属

远程客户端设置属于客户端 profile：

```yaml
hub.endpoints:
  - id: remote:office
    label: Office computer
    uri: ws://192.168.1.20:8765/hub
    credentialRef: hub-token-office
    enabled: true
```

Hub 服务端设置属于发布会话的 Host：

```yaml
hub.server:
  enabled: false
  host: 127.0.0.1
  port: 8765
  serverName: my-hub
  credentialRef: hub-server-token
```

凭据通过 Harness credentials 服务保存。浏览器 localStorage 只保存已选择的工作区 ID 和界面状态，不保存认证 Token。

## 设置页面

Hub 设置页包含两个区域：

- **远程连接**管理多个 Hub 端点、连接测试、启用状态、删除、连接状态，以及加载到首页的远程工作区。
- **本机作为 Hub**管理本机 Hub listener，包括启用状态、监听地址、端口、服务名称、凭据、生命周期控制，以及供其他客户端复制的连接地址。

小电脑图标只属于设置页面中的远程连接入口和远程端点条目，用于标识已配置的远程端点。首页项目列表不使用这个图标作为项目标记。

在设置中选择远程工作区后，客户端发布由 `(endpointId, workspaceId)` 组成的过滤条件。首页项目只根据该过滤条件和所属远程 Host 返回的数据生成。未选择的远程工作区不会出现在首页，也不会进入未分组区域。

## 服务端生命周期

`HubServerManager` 负责 listener 生命周期。设置更新必须先完成校验再应用。监听地址或端口变化时，管理器停止旧 listener、关闭其客户端连接，并使用新配置启动 listener。如果新 listener 无法启动，管理器报告错误并保留之前正在运行的配置。

服务端在接受非回环访问前必须完成认证。设置页面显示连接地址和脱敏后的凭据状态，不显示保存的 Token 值。

## 包职责

- `hub/protocol` 定义 wire 类型和传输消息。
- `hub/server` 负责 listener、认证、客户端注册表和 Host API 转发。
- `hub/client` 负责一个远程端点的传输层。
- `hub/web-adapter` 为 Web runtime 解析端点传输层。
- `client/ui-hub` 渲染设置页并调用端点和服务端控制服务。

UI 包不打开 socket、不启动 listener、不持久化凭据，也不实现会话操作。

## 验证

多端点测试矩阵覆盖不同端点的重复会话 ID、独立客户端订阅、端点删除、连接失败、listener 重启失败、已选工作区过滤，以及设置持久化时不泄露凭据。
