# @deepseek-ai/dsh-hub-web-adapter

English | [中文](README.zh.md)

Owned browser transport for the Hub Web bundle. It qualifies every remote session with its endpoint identity and exposes the remote session operations used by Web UI packages.

This package is a library consumed by the owned Web client bundle; it is not a replacement for the Harness server or a modification required by an upstream Harness installation. Local sessions do not use this adapter.

## Model Experience

### Remote session context

#### What the model sees

Remote sessions expose the same session-facing operations as local sessions; the `endpointId` remains part of each reference and remote paths stay on the owning Host.

##### Remote operation scope

```markdown
Remote session history, prompts, cancellation, model selection, queue updates, attachments, forks, subagents, workspace actions, and live events are routed through the owning Host.
```

#### Token effect

The adapter adds no model tokens; the owning Host and its configured providers determine the request content.

#### KV Cache effect

No direct effect; the owning Host determines request-prefix changes.

## Known Limitations and Deferred Work

- **One transport per endpoint** — the adapter supports one configured transport per remote endpoint and routes through the current Hub Web API.
- **No Hub federation or failover** — Hub federation, automatic failover, and arbitrary endpoint networking are outside this adapter.
- **Remote execution stays remote** — remote path and process operations remain owned by the remote Host and are not executed through local browser providers.
