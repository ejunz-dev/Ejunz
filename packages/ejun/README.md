# Ejunz-Core

Based on Hydro-Core  

See [hydro-dev/Hydro/packages/hydrooj](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/README.md)  

## Agent web search

The host registers `web_search` through `src/tools/web.ts` and searches Exa. Set `EXA_API_KEY` in the environment of the Ejun process. The tool returns up to eight source URLs with highlights; results without an HTTP(S) URL or non-empty highlight are omitted. The host add-on is named `web` and intentionally shadows the embedded Agent `web_search` in sessions where the host tool is installed.
