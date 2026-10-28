# bundle/ — profile plugin bundles


Profile bundles: npm packages whose manifest declares `"ea": { "bundle": { "patch": "./cordis.patch.yml" } }`, making them installable patch layers for `ea --profile` compositions ([profile contract](../boot/app-boot/README.md#profiles)). A bundle's substance is its patch list; some also ship runtime glue plugins their patch mounts.

| Package | Role | ctx key |
|---|---|---|
| [`base/`](base/README.md) | The shared ea core every profile applies first | — (patch only) |
| [`profile-web/`](../../../packages/profile-web/README.md) | Generic browser surface and local Web storage | mounts rows |
| [`profile-ejunz/`](../../../packages/profile-ejunz/README.md) | Ejunz storage, session persistence and telemetry layer; follows `profile-web` | patch only |

In-box bundles resolve from the ea installation; out-of-tree bundles install into a profile through `ea plugin --profile <name> add <package>`.
