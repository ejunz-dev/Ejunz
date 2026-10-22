# Ejunz-Core

Based on Hydro-Core  

See [hydro-dev/Hydro/packages/hydrooj](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/README.md)  

## Agent tools

The `web` add-on registers a host-backed `web_search` through `src/tools/web.ts` and searches Exa. Set `EXA_API_KEY` in the environment of the Ejun process. It returns up to eight source URLs with highlights; results without an HTTP(S) URL or non-empty highlight are omitted. In sessions where the `web` add-on is installed, this host tool intentionally shadows the embedded Agent `web_search`.

The `agent-runtime` add-on registers the fixed/default Agent tools in `src/tools/agent-runtime.ts` and the category modules `agent-runtime-web.ts`, `agent-runtime-session.ts`, `agent-runtime-cordis.ts`, `agent-runtime-subagent.ts`, and `agent-runtime-workflow.ts`. Each tool has an Ejun-owned description, schema, and same-name forwarding executor; calls execute in the native Agent runtime. The session catalog exposes a static schema when it matches the native tool installed in that Agent scope, and uses the current runtime schema for configuration variants. MCP tools, Cordis plugin-defined tools, and host-supplied tools remain dynamic. Child-only tools appear only in child scopes. The add-on defaults to enabled; domains with an explicit add-on installation list must install it to expose these tools. The host-backed `web_search` remains the `web` add-on's implementation and shadows the native Agent tool of the same name.
