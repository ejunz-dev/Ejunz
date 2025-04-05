
import path from 'path';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import yaml from 'js-yaml';
import { pick } from 'lodash';
import { Binary, ObjectId } from 'mongodb';
import { Context } from '../context';
import {
    AuthOperationError, BlacklistedError, DomainAlreadyExistsError, InvalidTokenError,
    NotFoundError, PermissionError, UserAlreadyExistError,
    UserNotFoundError, ValidationError, VerifyPasswordError,
} from '../error';
import { DomainDoc, MessageDoc, Setting } from '../interface';
import avatar, { validate } from '../lib/avatar';
import * as mail from '../lib/mail';
import * as useragent from '../lib/useragent';
import { verifyTFA } from '../lib/verifyTFA';
// import BlackListModel from '../model/blacklist';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import domain from '../model/domain';
import message from '../model/message';
import ProblemModel from '../model/problem';
import * as setting from '../model/setting';
import storage from '../model/storage';
import * as system from '../model/system';
import token from '../model/token';
import * as training from '../model/training';
import user from '../model/user';
import {
    ConnectionHandler, Handler, param, query, requireSudo, subscribe, Types,
} from '../service/server';
import { camelCase, md5 } from '../utils';



export class ProcessingBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: 'Back to homepage',
                checker: () => true,
            },
        ];
    }
}
export class ProcessingHandler extends ProcessingBaseHandler {
    async get() {
        this.response.template = 'processing_main.html';
    }
}

export async function apply(ctx: Context) {
    ctx.on('handler/after', async (h) => {
        if (h.request.path === '/processing') {
            h.UiContext.spacename = 'processing';
        }
    }); 
    ctx.Route('processing_main', '/processing', ProcessingHandler);


}
