# Hub 双进程本地测试

[English](README.md) | 中文

这个目录用于模拟两台设备：远程端运行 `remote-server.yml`，本地端运行 `local-client.yml`。两个进程使用不同的 Web 端口，但通过 `8765/hub` 建立真实 WebSocket 连接。

当前仓库源码不能直接通过 `dsh plugin add file:...` 安装到默认 Web profile。默认 profile 位于用户目录下的独立 pnpm workspace，而 Hub 包依赖仓库内的 `workspace:^` 包；在插件发布或提供仓库内开发 profile 前，执行该安装命令会失败。

因此下面的启动命令暂时只作为目标流程记录，不能在未完成开发 profile 前直接运行。

在仓库根目录分别打开两个终端。

远程端：

```powershell
pnpm dsh web --patch .\examples\hub-local-test\remote-server.yml --port 3081
```

打开 `http://127.0.0.1:3081`，在工作区页面选择要暴露的项目目录。这个页面代表远程设备。

本地端：

```powershell
pnpm dsh web --patch .\examples\hub-local-test\local-client.yml --port 3080
```

打开 `http://127.0.0.1:3080`，进入设置里的 Hub，确认连接成功；回到首页后，远程工作区会出现在工作区列表中。点击它创建远程会话，再发送一条文本消息，回复应显示在普通对话区。

远程端必须配置可用的 `DEEPSEEK_API_KEY`。测试结束后，分别在两个终端按 `Ctrl+C`，只会停止各自启动的进程。
