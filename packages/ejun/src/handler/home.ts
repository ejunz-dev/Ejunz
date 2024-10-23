import { Handler } from '../service/server';

export class HomeHandler extends Handler {
    async get() {
        this.response.template = 'main.html';
        this.response.body = {
            title: 'Welcome to My Simple Page',
            message: 'This is a simple page served by our server.',
        };
    }
}

export async function apply(ctx) {
    ctx.Route('homepage', '/', HomeHandler);
}
