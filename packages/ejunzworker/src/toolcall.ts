import superagent from 'superagent';

export class ToolCallTaskHandler {
    constructor(
        private readonly serverUrl: string,
        private readonly cookie?: string,
        private readonly token?: string,
    ) {}

    private post(url: string, data?: any) {
        const target = new URL(url, this.serverUrl).toString();
        const req = superagent.post(target).set('Accept', 'application/json');
        if (this.cookie) req.set('Cookie', this.cookie);
        if (this.token) req.set('Authorization', `Bearer ${this.token}`);
        return data ? req.send(data) : req;
    }

    async handle(t: any, sendNext: (data: any) => Promise<void> | void, sendEnd: (data: any) => Promise<void> | void) {
        await sendNext({ status: 'running', toolName: t.toolName || t.name });
        const res = await this.post('toolcall/internal', {
            domainId: t.domainId,
            toolName: t.toolName || t.name,
            args: t.args || {},
            baseDocId: t.baseDocId,
            baseBranch: t.baseBranch,
            owner: t.owner,
            toolType: t.toolType,
            token: t.token,
            mcpId: t.mcpId,
        });
        const body = res.body || {};
        if (body.error) await sendEnd({ error: body.error });
        else await sendEnd({ result: body.result });
    }
}
