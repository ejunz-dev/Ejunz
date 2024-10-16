import type { KoaContext } from '@ejunz/framework';
import { PERM } from '../../model/builtin';
import UserModel from '../../model/user';

export default async (ctx: KoaContext, next) => {
    // User Layer
    const { args } = ctx.HydroContext;
    let user = await UserModel.getById(ctx.session.uid, ctx.session.scope);
    if (!user) {
        ctx.session.uid = 0;
        ctx.session.scope = PERM.PERM_ALL.toString();
        user = await UserModel.getById(ctx.session.uid, ctx.session.scope);
    }
    if (user._id === 0) delete user.viewLang;
    ctx.HydroContext.user = await user.private();
    await next();
};
