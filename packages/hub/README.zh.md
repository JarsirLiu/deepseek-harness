# Hub Packages

[English](README.md) | 中文

远程 Hub 能力拆分为可独立发布的包。部署只安装所需角色，再通过 Harness profile 组合它们。

## 包

- [`protocol/`](protocol/)：共享 WebSocket JSON-RPC 类型与传输辅助代码，仅作为库使用。
- [`server/`](server/)：向远程客户端暴露本地会话的 Cordis 插件。
- [`client/`](client/)：将远程 Hub 作为会话 provider 使用的 Cordis 插件。
- [`../client/ui-hub/`](../client/ui-hub/)：可选的 Hub 状态浏览器设置区。

server 与 client 包包含用于 profile 安装的 bundle patch。protocol 包没有 Cordis row，会作为运行时角色的依赖安装。

## 拓扑

server 持有本地会话并接受 WebSocket JSON-RPC 连接。client 连接一个 server，并通过 Harness session capability 提供远程会话。UI 包与传输独立，通过 Web host 读取 client 状态端点。

## 安装

使用 Harness plugin manager 安装 server 或 client 包，然后启用 profile row，并在 profile patch 中配置包自有字段。具体配置和所需 peer 包由各包 README 说明。

## Model Experience

Hub 包不增加模型可见输入。它们传输或展示会话状态；持久化日志与模型 transcript 仍由 session 包负责。

#### KV Cache effect

无直接影响；Hub 传输不会组装 provider 请求。

## 已知限制与后续工作

- **需要兼容版本**：wire protocol 变化时，server、client 与 protocol 必须一起发布兼容版本。
- **认证由部署负责**：网络暴露、TLS 终止和凭据分发不属于这些包。
