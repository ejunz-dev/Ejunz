import type { Context } from '../context';
import { UserAlreadyExistError, UserNotFoundError, LoginError } from '../error';
import user from '../model/user';
import { Handler, param, post, Types } from '../service/server';

class UserLoginHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.response.template = 'user_login.html';
    }

    @param('uname', Types.String)
    @param('password', Types.String)
    async post(domainId: string, uname: string, password: string) {
        let udoc = await user.getByUname(domainId, uname);
        if (!udoc) throw new UserNotFoundError(uname);

        await udoc.checkPassword(password);
        
        this.context.HydroContext.user = udoc;
        this.session.uid = udoc._id;
        this.response.redirect = '/';
    }
}

class UserLogoutHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.response.template = 'user_logout.html';
    }

    async post({ domainId }) {
        this.context.HydroContext.user = await user.getById(domainId, 0);
        this.session.uid = 0;
        this.response.redirect = '/';
    }
}

export class UserRegisterHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.response.template = 'user_register.html';
    }

    @param('uname', Types.String)
    @param('password', Types.String)
    async post(domainId: string, uname: string, password: string) {
        if (await user.getByUname(domainId, uname)) throw new UserAlreadyExistError(uname);
        
        const uid = await user.create(uname, password, this.request.ip);
        
        this.context.HydroContext.user = await user.getById(domainId, uid);
        this.session.uid = uid;
        this.response.redirect = '/';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('user_login', '/login', UserLoginHandler);
    ctx.Route('user_register', '/register', UserRegisterHandler);
    ctx.Route('user_logout', '/logout', UserLogoutHandler);
}
