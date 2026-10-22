# Ejunz-Core

Based on Hydro-Core  

See [hydro-dev/Hydro/packages/hydrooj](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/README.md)  

## Agent tools

The `web` add-on registers a host-backed `web_search` through `src/tools/web.ts` and searches Exa. Set `EXA_API_KEY` in the environment of the Ejun process. It returns up to eight source URLs with highlights; results without an HTTP(S) URL or non-empty highlight are omitted. In sessions where the `web` add-on is installed, this host tool intentionally shadows the embedded Agent `web_search`.

The `agent-runtime` add-on registers the fixed/default Agent tool catalog in `src/tools/agent-runtime-catalog.ts`; `src/tools/agent-runtime.ts` supplies same-name forwarding executors. Its session catalog exposes a static descriptor when it matches the native tool installed in that Agent scope, and falls back to the current runtime schema for configuration variants. MCP, Cordis plugin-defined tools, and host-supplied tools remain runtime/catalog-provided. Calls delegate to the captured native Agent implementation, preserving its session and lifecycle behavior. Child-only tools appear only in child scopes. The add-on defaults to enabled; domains with an explicit add-on installation list must install it to expose these tools. The host-backed `web_search` remains the `web` add-on's implementation and shadows the native Agent tool of the same name.
