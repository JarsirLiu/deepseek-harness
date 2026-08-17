# @deepseek-ai/dsh-hub-protocol

English | [中文](README.zh.md)

Shared protocol library for the remote Hub capability. It defines the WebSocket JSON-RPC messages and the TypeScript response types consumed by the Hub server, Hub client, and optional Web UI.

## Usage

Install this package as a dependency of a Hub runtime role. It has no Cordis plugin row, no profile patch, and no process entrypoint. The exported types describe the status response used by the browser settings section, Endpoint Agent registration and workspace discovery, and the session operations used by the server and client.

## Model Experience

### Protocol data

#### What the model sees

None. This package defines transport data such as `HubStatusResponse` and does not access a model or session store.

#### Token effect

None; the package contributes no prompt content.

#### KV Cache effect

None; it contains no provider request code.

## Known Limitations and Deferred Work

- **Protocol compatibility is versioned by package release** — server and client releases must use compatible protocol versions.
