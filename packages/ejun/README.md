# Ejunz-Core

Based on Hydro-Core  

See [hydro-dev/Hydro/packages/hydrooj](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/README.md)  

## Agent tools

The `web` add-on registers a host-backed `web_search` through `src/tools/web.ts` and searches Exa. Set `EXA_API_KEY` in the environment of the Ejun process. It returns up to eight source URLs with highlights; results without an HTTP(S) URL or non-empty highlight are omitted. In sessions where the `web` add-on is installed, this host tool intentionally shadows the embedded Agent `web_search`.

The `agent-runtime` add-on exposes native Agent tools through the Ejun host catalog. Ejun declares wrappers for `todo_write`, `ask_user_question`, the `job_*` tools, the goal tools, `skill`, and `exit_plan_mode`; the session catalog also includes other tools installed in that Agent scope, such as web fetch, scheduling, session query, LSP, subagent/workflow, Cordis, and MCP tools. The Agent supplies its current scoped schemas; Ejun filters them by session add-on availability and returns a same-name delegation marker, and the Agent runtime executes the captured native tool. Child-only and dynamically installed tools are only offered when present in that Agent scope. The add-on defaults to enabled; domains with an explicit add-on installation list must install it to expose delegated tools. The host-backed `web_search` remains the `web` add-on's implementation and shadows the native Agent tool of the same name.
