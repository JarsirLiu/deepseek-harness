# Agent Note: 将远程 Hub 能力作为独立包发布

Status: implemented

[English](2026-08-14-installable-remote-hub-packages.md) | 中文

## Problem

远程 Hub 支持由 wire protocol、服务端 provider、客户端 provider 和可选的浏览器设置区组成。消费者需要按部署场景只安装所需角色，同时 Harness profile 仍能在不依赖应用代码直接导入的情况下组合兼容角色。

## Decision

Hub 能力发布为三个可安装运行时包和一个可选 UI 包：

- `@deepseek-ai/dsh-hub-protocol` 作为库发布共享传输与响应类型，不提供 Cordis row。
- `@deepseek-ai/dsh-hub-server` 发布 Cordis 插件和 bundle patch，通过 WebSocket JSON-RPC 暴露本地会话，接受经过认证的 Endpoint Agent 注册，并发布已注册工作区目录供 Client 发现。
- `@deepseek-ai/dsh-hub-client` 发布 Cordis 插件和 bundle patch，连接 Hub server，提供远程会话 provider、Agent 命令和事件通知给 Host API，并导出显式的 `HubEndpointAgent` 注册客户端。
- `@deepseek-ai/dsh-client-ui-hub` 发布浏览器设置区。它通过 `settings.section` 注册，依赖注入的 slot/runtime/locale 服务，并将缺少 `/api/hub/status` 端点表示为明确的 unavailable 状态。它不持有 Hub 传输或持久化。

每个包都在 `package.json` 中声明发布入口、发布文件、peer 依赖和仓库目录。Web bundle 声明 UI 包依赖与 `dsh.client` row；server 与 client 包分别声明自己的 bundle patch。这样包安装与 profile 组合都保持显式。

## Alternatives considered

- **发布一个单体 Hub 包**：否决，因为服务端部署不应安装浏览器展示，轻量客户端也不应安装仅服务端代码。
- **让 UI 组件直接调用 Hub service**：否决，因为展示组件必须通过 slot 注入接收业务操作，传输归 Host 插件所有。
- **把所有失败状态响应都视为 disconnected**：否决，因为端点不存在与已配置端点失败代表不同部署含义，必须保持可区分。

## Consequences

消费者可以独立安装 protocol、server、client 和 UI 角色，profile manifest 表达有效的组合边。Host API 使用已安装的 hub client 作为远程 prompt 与事件载体；Host 端点缺失时 UI 包保持显式且无操作。跨包兼容性由共享 workspace 版本范围和 protocol 响应类型约束；独立发布意味着 wire contract 变化时仍需一起发布兼容版本。

## Verification

UI 组件测试覆盖 loading、全部连接状态、端点不可用、错误详情和重试行为。TypeScript project references 校验 protocol、server、client 和 Host API 入口及声明的依赖图。Hub client 校验端点身份只能来自握手，Server 校验显式 Agent 凭据与重复注册，真实三进程 WebSocket 测试使用隔离进程验证 Broker、Endpoint Agent 注册和 Client 目录发现。已注册 Agent 的 API 转发属于独立能力。
