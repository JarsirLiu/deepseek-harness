# Local Two-Process Hub Test

English | [中文](README.zh.md)

This directory simulates two devices: run `remote-server.yml` on the remote device and `local-client.yml` on the local device. The processes use different Web ports and establish a real WebSocket connection through `8765/hub`.

The repository source cannot currently be installed into the default Web profile with `dsh plugin add file:...`. The default profile is an independent pnpm workspace under the user directory, while the Hub packages depend on repository-local `workspace:^` packages. Until the packages are published or a repository development profile is provided, the install command fails.

The commands below therefore document the target flow and cannot be run directly before the development profile is available.

Open two terminals at the repository root.

Remote device:

```powershell
pnpm dsh web --patch .\examples\hub-local-test\remote-server.yml --port 3081
```

Open `http://127.0.0.1:3081` and select the project directory to expose on the workspace page. This page represents the remote device.

Local device:

```powershell
pnpm dsh web --patch .\examples\hub-local-test\local-client.yml --port 3080
```

Open `http://127.0.0.1:3080`, enter Hub settings, and confirm the connection. Return to the home page and the remote workspace should appear in the workspace list. Select it, create a remote session, and send a text message; the reply should appear in the normal conversation area.

The remote device must have a usable `DEEPSEEK_API_KEY`. After the test, press `Ctrl+C` in both terminals; each command stops only its own process.
