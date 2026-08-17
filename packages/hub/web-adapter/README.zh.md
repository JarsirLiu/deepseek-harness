[English](README.md) | 中文

# @deepseek-ai/dsh-hub-web-adapter

Hub Web bundle 所有的浏览器传输层。它为每个远程会话保留所属端点身份，并向 Web UI 暴露远程会话操作。

该包是项目自有 Web 客户端 bundle 使用的库，不替代 Harness server，也不要求上游 Harness 安装任何修改。本地会话不使用此 adapter。

## Model Experience

### 远程会话上下文

#### 模型看到的内容

远程会话与本地会话使用同一套面向会话的操作；每个引用都保留 `endpointId`，远程路径继续由所属 Host 处理。

##### 远程操作范围

```markdown
Remote session history, prompts, cancellation, model selection, queue updates, attachments, forks, subagents, workspace actions, and live events are routed through the owning Host.
```

#### Token effect

adapter 不增加模型 Token；请求内容由所属 Host 及其配置的 provider 决定。

#### KV Cache effect

没有直接影响；请求前缀的变化由所属 Host 决定。

## Known Limitations and Deferred Work

- **每个端点一个传输层**：adapter 为每个远程端点支持一个已配置的传输层，并通过当前 Hub Web API 路由。
- **不提供 Hub 联邦或故障切换**：Hub 联邦、自动故障切换和端点之间的任意网络访问不属于此 adapter。
- **远程执行仍在远端**：远程路径和进程仍由远程 Host 所有，不通过本地浏览器 provider 执行。
