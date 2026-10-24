export const UI_NEXT_INJECTION_MARKER = '<!-- __EJUNZ_INJECTION__DO_NOT_REMOVE_THIS__ -->';

export interface UiNextPageInjection {
    EJUNZ_INJECTED: true;
    name: string;
    template?: string;
    args: Record<string, unknown>;
    url: string;
    route_map?: Record<string, string>;
    endpoint?: string;
    plugins_url?: string;
}

export function injectUiNextPageData(html: string, data: UiNextPageInjection) {
    if (!html.includes(UI_NEXT_INJECTION_MARKER)) {
        throw new Error('ui-next HTML injection marker is missing');
    }
    const json = JSON.stringify(data).replace(/</g, String.fromCharCode(92) + 'u003c');
    const injection = `<script id="__EJUNZ_INJECTION__" type="application/json">${json}</script>`;
    return html.replace(UI_NEXT_INJECTION_MARKER, injection);
}
