# ejunz-agent


Ejunz Agent runtime and command-line launcher. The embedded Host API bundle has no browser UI.

## Development (from source)

```sh
yarn install
yarn ea --profile headless "task"  # run one task and exit
yarn ea node                        # join an Ejunz host
```

## Production

```sh
npm install -g @ejunz/ea
ea --profile headless "task"
ea node
```

Real-model runs need `DEEPSEEK_API_KEY` in the root `.env`.

## CLI

`ea` is the command-line launcher for Agent profiles and remote Agent runtimes.

```sh
ea --profile headless "task"  # run one task and exit
ea node                     # connect this runtime to its Ejunz host
ea plugin --profile headless add <package>
```

Profiles are ordered stacks of bundles and Cordis patch layers. Inspect a profile with `--dump-config` or `--dump-default-config`.
