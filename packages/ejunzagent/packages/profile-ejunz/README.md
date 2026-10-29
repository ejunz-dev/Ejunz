# `@ejunz/profile-ejunz`

Ejunz-specific profile bundle for EjunzAgent. Add it after `@ejunz/profile-web` to select Ejunz-hosted storage, session persistence and telemetry. The shipped `ejunz` profile composes `@ejunz/ea-core`, `@ejunz/profile-web`, then this bundle.

The generic `web` profile does not include this package; it uses local JSON storage and JSONL session persistence. For standalone launches, the CLI checks `config.agent.yaml` in the current working directory. If missing, it creates the file from `config.agent.example.yaml` and asks you to fill it before starting:

```yaml
bridge:
  origin: 'http://your-ejunz-host:port'
  token: 'token-issued-by-your-ejunz-host'
```

Embedded launches receive the bridge from their owning host and do not need this file. The `config.node.yaml` used by `ejunz-node` configures its separate Node-to-Edge WebSocket connection; its `ws.endpoint` and `ws.token` are not the HTTP data-bridge settings above.

## Known Limitations and Deferred Work

- This bundle expects `@ejunz/profile-web` to be applied before it; the shipped `ejunz` profile provides that ordering.
- Ejunz storage and session persistence require a reachable Ejunz host and valid bridge credentials. The generic `web` profile is the offline/local option.
