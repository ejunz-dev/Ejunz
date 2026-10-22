# Ejunz-Core

Based on Hydro-Core  

See [hydro-dev/Hydro/packages/hydrooj](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/README.md)  

## Agent tools

The `web` add-on registers a host-backed `web_search` through `src/tools/web.ts` and searches Exa. Set `EXA_API_KEY` in the environment of the Ejun process. It returns up to eight source URLs with highlights; results without an HTTP(S) URL or non-empty highlight are omitted. In sessions where the `web` add-on is installed, this host tool intentionally shadows the embedded Agent `web_search`.

The `agent-runtime` add-on exposes `todo_write`, `ask_user_question`, `job_list`, `job_output`, `job_kill`, `get_goal`, `create_goal`, `update_goal`, `skill`, and `exit_plan_mode` through the Ejun host tool catalog. Calls delegate to the matching native Agent runtime tools, preserving their session event, interaction, job, goal, skill, and plan behavior. The add-on defaults to enabled; domains with an explicit add-on installation list must install it to expose these tools.
