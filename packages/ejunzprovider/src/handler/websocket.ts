import { Context } from 'ejun';
import { handleWebSocket } from './logs';

export async function apply(ctx: Context) {
    ctx.server?.router.ws('/mcp/ws', (socket, request, ctx) => {
        handleWebSocket(socket);
    });
}
