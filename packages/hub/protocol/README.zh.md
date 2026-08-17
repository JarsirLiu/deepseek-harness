# @deepseek-ai/dsh-hub-protocol

[English](README.md) | 中文

远程 Hub 能力的共享 protocol 库。它定义 WebSocket JSON-RPC 消息以及 Hub server、Hub client 和可选 Web UI 共同使用的 TypeScript 响应类型。

## 使用方式

将本包作为 Hub 运行时角色的依赖安装。本包没有 Cordis plugin row、profile patch 或进程入口。导出的类型描述浏览器设置区使用的状态响应、Endpoint Agent 注册、工作区发现、端点限定的 API 请求，以及 server 与 client 使用的会话操作。

## Model Experience

### Protocol 数据

#### What the model sees

无。本包定义 `HubStatusResponse` 等传输数据，不访问模型或会话存储。

#### Token effect

无；本包不贡献 prompt 内容。

#### KV Cache effect

无；本包不包含 provider 请求代码。

## 已知限制与后续工作

- **Protocol 兼容性按包版本发布**：server 与 client 必须使用兼容的 protocol 版本。
