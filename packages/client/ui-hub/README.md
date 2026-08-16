# @deepseek-ai/dsh-client-ui-hub

English | [中文](README.zh.md)

The browser settings section for the remote Hub connection. It registers status and Remote Chat entries through the client slot system. Remote Chat connects to the configured Hub, lists or creates sessions, streams events, sends prompts, and cancels active turns. The feature is plugin-owned; it does not modify Harness core or the local composer.

The multi-endpoint settings and icon placement contract is documented in [`docs/hub-endpoints.md`](../../../docs/hub-endpoints.md). The small computer icon belongs to the settings-page remote connection entry; the home page project list does not use it.

## Composition

Install this package as part of a Web profile that also provides [`dsh-client-ui-settings`](../ui-settings/README.md), [`dsh-client-runtime`](../runtime/README.md), the locale and slot services, and [`dsh-hub-protocol`](../../hub/protocol/README.md). The web bundle declares this package in its `dsh.client` composition, so a profile that includes the package receives the section without application code importing the component.

The section requests `/api/hub/status` with same-origin credentials. A `404` is the explicit unavailable result used when no Hub client endpoint is installed. Other non-success responses are errors and remain visible with a retry action; the component does not substitute a connection state or server value.

## Public API

The package's Cordis entry is `@deepseek-ai/dsh-client-ui-hub/client`. Its public runtime exports are limited to `apply` and `inject`; `HubSectionProps`, `HubStatusResult`, and `HubLocaleKey` are exported for typed composition. The component implementation and request loader stay internal to the package.

## Model Experience

### Connection metadata

#### What the model sees

None. This package renders connection metadata for a human and does not read or modify sessions, prompts, messages, tools, model requests, or the session log; its only runtime input is `/api/hub/status`.

#### Token effect

None; the package contributes no model-visible content.

#### KV Cache effect

None; the package never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **Status is read-only** — changing the Hub URI or credentials belongs to profile configuration and is not edited from this section.
- **The section depends on the host endpoint** — installing the UI package without `dsh-hub-client` renders the explicit not-configured state.

Configure it with `@deepseek-ai/dsh-hub-client` and `@deepseek-ai/dsh-hub-server`:

```yaml
- name: '@deepseek-ai/dsh-hub-client'
  config:
    uri: 'ws://127.0.0.1:8765/hub'
    token: 'local-test-token'
- name: '@deepseek-ai/dsh-client-ui-hub'
```
