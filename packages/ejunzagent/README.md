# ejunz-agent


Ejunz Agent runtime and command-line launcher. Profiles compose the generic Web surface with optional Ejunz-hosted integrations.

## Development (from source)

```sh
yarn install
yarn ea --profile web    # start the local Web profile
yarn ea --profile ejunz  # start the Ejunz-integrated profile
```

## Production

```sh
npm install -g @ejunz/ea
ea --profile web
ea --profile ejunz
```

Real-model runs need `DEEPSEEK_API_KEY` in the root `.env`.

## CLI

`ea` is the command-line launcher for Agent profiles and their ordered bundle stacks.

```sh
ea --profile web    # start the local Web profile
ea --profile ejunz  # start the Ejunz-integrated profile
ea plugin --profile web add <package>
```

Profiles are ordered stacks of bundles and Cordis patch layers. Inspect a profile with `--dump-config` or `--dump-default-config`.
