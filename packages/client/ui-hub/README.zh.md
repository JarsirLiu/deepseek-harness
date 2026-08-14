# @deepseek-ai/dsh-client-ui-hub

[English](README.md) | 中文

远程 Hub 连接的浏览器设置区。它通过客户端 slot 系统注册一个 `settings.section` 条目，并通过注入的回调读取 Host 侧 `hub-client` 状态端点。本包只负责展示和请求结果映射；WebSocket 连接与会话持久化由 [`dsh-hub-client`](../../hub/client/README.md) 持有。

## 组合方式

将本包安装到同时提供 [`dsh-client-ui-settings`](../ui-settings/README.md)、[`dsh-client-runtime`](../runtime/README.md)、locale 与 slot 服务以及 [`dsh-hub-protocol`](../../hub/protocol/README.md) 的 Web profile 中。Web bundle 在 `dsh.client` 组合中声明本包，因此 profile 包含它后会获得该设置区，应用代码不需要直接导入组件。

设置区使用同源凭据请求 `/api/hub/status`。没有安装 Hub client 端点时，`404` 映射为明确的 unavailable 状态。其他非成功响应都是错误，会在界面中保留并提供重试操作；组件不会替换连接状态或服务器字段。

## 公共 API

本包的 Cordis 入口是 `@deepseek-ai/dsh-client-ui-hub/client`。公共运行时导出仅限 `apply` 与 `inject`；`HubSectionProps`、`HubStatusResult` 和 `HubLocaleKey` 作为类型化组合所需的类型导出。组件实现与请求加载器保持在包内部。

## Model Experience

### 连接元数据

#### What the model sees

无。本包只为人展示连接元数据，不读取或修改会话、提示词、消息、工具、模型请求或会话日志；它唯一的运行时输入是 `/api/hub/status`。

#### Token effect

无；本包不贡献模型可见内容。

#### KV Cache effect

无；本包不会组装或发送 provider 请求。

## 已知限制与后续工作

- **状态为只读**：Hub URI 与凭据的修改属于 profile 配置，不在此设置区编辑。
- **设置区依赖 Host 端点**：只安装 UI 包而没有 `dsh-hub-client` 时，界面会显示明确的未配置状态。
