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


 export class HomeHandler extends Handler {
    async get() {
        this.response.template = 'home_main.html';
    }
}



let geoip: Context['geoip'] = null;
class HomeSecurityHandler extends Handler {
    @requireSudo
    async get() {
        // TODO(iceboy): pagination? or limit session count for uid?
        const sessions = await token.getSessionListByUid(this.user._id);
        for (const session of sessions) {
            session.isCurrent = session._id === this.session._id;
            session._id = md5(session._id);
            session.updateUa = useragent.parse(session.updateUa || session.createUa || '');
            session.updateGeoip = geoip?.lookup?.(
                session.updateIp || session.createIp,
                this.translate('geoip_locale'),
            );
        }
        this.response.template = 'home_security.html';
        this.response.body = {
            sudoUid: this.session.sudoUid || null,
            sessions,
            authenticators: this.user._authenticators.map((c) => pick(c, [
                'credentialID', 'name', 'credentialType', 'credentialDeviceType',
                'authenticatorAttachment', 'regat', 'fmt',
            ])),
            geoipProvider: geoip?.provider,
            icon: (str = '') => str.split(' ')[0].toLowerCase(),
        };
    }

    @requireSudo
    @param('current', Types.String)
    @param('password', Types.Password)
    @param('verifyPassword', Types.Password)
    async postChangePassword(domainId: string, current: string, password: string, verify: string) {
        if (password !== verify) throw new VerifyPasswordError();
        if (this.session.sudoUid) {
            const udoc = await user.getById(domainId, this.session.sudoUid);
            if (!udoc) throw new UserNotFoundError(this.session.sudoUid);
            await udoc.checkPassword(current);
        } else await this.user.checkPassword(current);
        await user.setPassword(this.user._id, password);
        await token.delByUid(this.user._id);
        this.response.redirect = this.url('user_login');
    }

    @requireSudo
    @param('password', Types.Password)
    @param('mail', Types.Email)
    async postChangeMail(domainId: string, current: string, email: string) {
        const mailDomain = email.split('@')[1];
        if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);
        if (this.session.sudoUid) {
            const udoc = await user.getById(domainId, this.session.sudoUid);
            if (!udoc) throw new UserNotFoundError(this.session.sudoUid);
            await udoc.checkPassword(current);
        } else await this.user.checkPassword(current);
        const udoc = await user.getByEmail(domainId, email);
        if (udoc) throw new UserAlreadyExistError(email);
        await this.limitRate('send_mail', 3600, 30);
        const [code] = await token.add(
            token.TYPE_CHANGEMAIL,
            system.get('session.unsaved_expire_seconds'),
            { uid: this.user._id, email },
        );
        const prefix = (this.domain.host || [])[0] || system.get('server.url');
        const m = await this.renderHTML('user_changemail_mail.html', {
            path: `/home/changeMail/${code}`,
            uname: this.user.uname,
            url_prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
        });
        await mail.sendMail(email, 'Change Email', 'user_changemail_mail', m);
        this.response.template = 'user_changemail_mail_sent.html';
    }

    @param('tokenDigest', Types.String)
    async postDeleteToken(domainId: string, tokenDigest: string) {
        const sessions = await token.getSessionListByUid(this.user._id);
        for (const session of sessions) {
            if (tokenDigest === md5(session._id)) {
                // eslint-disable-next-line no-await-in-loop
                await token.del(session._id, token.TYPE_SESSION);
                return this.back();
            }
        }
        throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_SESSION], tokenDigest);
    }

    async postDeleteAllTokens() {
        await token.delByUid(this.user._id);
        this.response.redirect = this.url('user_login');
    }

    @requireSudo
    @param('code', Types.String)
    @param('secret', Types.String)
    async postEnableTfa(domainId: string, code: string, secret: string) {
        if (this.user._tfa) throw new AuthOperationError('2FA', 'enabled');
        if (!verifyTFA(secret, code)) throw new InvalidTokenError('2FA');
        await user.setById(this.user._id, { tfa: secret });
        this.back();
    }

    getAuthnHost() {
        return system.get('authn.host') && this.request.hostname.includes(system.get('authn.host'))
            ? system.get('authn.host') : this.request.hostname;
    }

    @requireSudo
    @param('type', Types.Range(['cross-platform', 'platform']))
    async postRegister(domainId: string, type: 'cross-platform' | 'platform') {
        const options = await generateRegistrationOptions({
            rpName: system.get('server.name'),
            rpID: this.getAuthnHost(),
            userID: this.user._id.toString(),
            userDisplayName: this.user.uname,
            userName: `${this.user.uname}(${this.user.mail})`,
            attestationType: 'direct',
            excludeCredentials: this.user._authenticators.map((c) => ({
                id: c.credentialID.buffer,
                type: 'public-key',
            })),
            authenticatorSelection: {
                authenticatorAttachment: type,
            },
        });
        this.session.webauthnVerify = options.challenge;
        this.response.body.authOptions = options;
    }

    @requireSudo
    @param('name', Types.String)
    async postEnableAuthn(domainId: string, name: string) {
        if (!this.session.webauthnVerify) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_WEBAUTHN]);
        const verification = await verifyRegistrationResponse({
            response: this.args.result,
            expectedChallenge: this.session.webauthnVerify,
            expectedOrigin: this.request.headers.origin,
            expectedRPID: this.getAuthnHost(),
        }).catch(() => { throw new ValidationError('verify'); });
        if (!verification.verified) throw new ValidationError('verify');
        const info = verification.registrationInfo;
        const id = Buffer.from(info.credentialID);
        if (this.user._authenticators.find((c) => c.credentialID.buffer.toString() === id.toString())) throw new ValidationError('authenticator');
        this.user._authenticators.push({
            ...info,
            credentialID: new Binary(id),
            credentialPublicKey: new Binary(Buffer.from(info.credentialPublicKey)),
            attestationObject: new Binary(Buffer.from(info.attestationObject)),
            name,
            regat: Date.now(),
            authenticatorAttachment: this.args.result.authenticatorAttachment || 'cross-platform',
        });
        await user.setById(this.user._id, { authenticators: this.user._authenticators });
        this.back();
    }

    @requireSudo
    @param('id', Types.String)
    async postDisableAuthn(domainId: string, id: string) {
        const authenticators = this.user._authenticators?.filter((c) => Buffer.from(c.credentialID.buffer).toString('base64') !== id);
        if (this.user._authenticators?.length === authenticators?.length) throw new ValidationError('authenticator');
        await user.setById(this.user._id, { authenticators });
        this.back();
    }

    @requireSudo
    async postDisableTfa() {
        if (!this.user._tfa) throw new AuthOperationError('2FA', 'disabled');
        await user.setById(this.user._id, undefined, { tfa: '' });
        this.back();
    }
}

function set(s: Setting, key: string, value: any) {
    if (s) {
        if (s.family === 'setting_storage') return undefined;
        if (s.flag & setting.FLAG_DISABLED) return undefined;
        if ((s.flag & setting.FLAG_SECRET) && !value) return undefined;
        if (s.type === 'boolean') {
            if (value === 'on') return true;
            return false;
        }
        if (s.type === 'number') {
            if (!Number.isSafeInteger(+value)) throw new ValidationError(key);
            return +value;
        }
        if (s.subType === 'yaml') {
            try {
                yaml.load(value);
            } catch (e) {
                throw new ValidationError(key);
            }
        }
        return value;
    }
    return undefined;
}

class HomeSettingsHandler extends Handler {
    @param('category', Types.Range(['preference', 'account', 'domain']))
    async get(domainId: string, category: string) {
        this.response.template = 'home_settings.html';
        this.response.body = {
            category,
            page_name: `home_${category}`,
            current: this.user,
        };
        if (category === 'preference') {
            this.response.body.settings = setting.PREFERENCE_SETTINGS;
        } else if (category === 'account') {
            this.response.body.settings = setting.ACCOUNT_SETTINGS;
        } else if (category === 'domain') {
            this.response.body.settings = setting.DOMAIN_USER_SETTINGS;
        } else throw new NotFoundError(category);
    }

    async post(args: any) {
        const $set = {};
        const booleanKeys = args.booleanKeys || {};
        delete args.booleanKeys;
        const setter = args.category === 'domain'
            ? (s) => domain.setUserInDomain(args.domainId, this.user._id, s)
            : (s) => user.setById(this.user._id, s);
        const settings = args.category === 'domain' ? setting.DOMAIN_USER_SETTINGS_BY_KEY : setting.SETTINGS_BY_KEY;
        for (const key in args) {
            const val = set(settings[key], key, args[key]);
            if (val !== undefined) $set[key] = val;
        }
        for (const key in booleanKeys) if (!args[key]) $set[key] = false;
        if (Object.keys($set).length) await setter($set);
        if (args.viewLang && args.viewLang !== this.session.viewLang) this.session.viewLang = '';
        this.back();
    }
}

class HomeAvatarHandler extends Handler {
    @param('avatar', Types.String, true)
    async post(domainId: string, input: string) {
        if (input) {
            if (!validate(input)) throw new ValidationError('avatar');
            await user.setById(this.user._id, { avatar: input });
        } else if (this.request.files.file) {
            const file = this.request.files.file;
            if (file.size > 8 * 1024 * 1024) throw new ValidationError('file');
            const ext = path.extname(file.originalFilename).toLowerCase();
            if (!['.jpg', '.jpeg', '.png'].includes(ext)) throw new ValidationError('file');
            await storage.put(`user/${this.user._id}/.avatar${ext}`, file.filepath, this.user._id);
            // TODO: cached avatar
            await user.setById(this.user._id, { avatar: `url:/file/${this.user._id}/.avatar${ext}` });
        } else throw new ValidationError('avatar');
        this.back();
    }
}

class UserChangemailWithCodeHandler extends Handler {
    @param('code', Types.String)
    async get(domainId: string, code: string) {
        const tdoc = await token.get(code, token.TYPE_CHANGEMAIL);
        if (!tdoc || tdoc.uid !== this.user._id) {
            throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_CHANGEMAIL], code);
        }
        const udoc = await user.getByEmail(domainId, tdoc.email);
        if (udoc) throw new UserAlreadyExistError(tdoc.email);
        await Promise.all([
            user.setEmail(this.user._id, tdoc.email),
            token.del(code, token.TYPE_CHANGEMAIL),
        ]);
        this.response.redirect = this.url('home_security');
    }
}

class HomeDomainHandler extends Handler {
    @query('all', Types.Boolean)
    async get(domainId: string, all: boolean) {
        let res: DomainDoc[] = [];
        let dudict: Record<string, any> = {};
        if (!all) {
            dudict = await domain.getDictUserByDomainId(this.user._id);
            const dids = Object.keys(dudict);
            res = await domain.getMulti({ _id: { $in: dids } }).toArray();
        } else {
            this.checkPriv(PRIV.PRIV_VIEW_ALL_DOMAIN);
            res = await domain.getMulti().toArray();
            await Promise.all(res.map(async (ddoc) => {
                dudict[ddoc._id] = await user.getById(domainId, this.user._id);
            }));
        }
        const canManage = {};
        const ddocs = [];
        for (const ddoc of res) {
            // eslint-disable-next-line no-await-in-loop
            const udoc = (await user.getById(ddoc._id, this.user._id))!;
            const dudoc = dudict[ddoc._id];
            if (['default', 'guest'].includes(dudoc.role)) {
                delete dudict[ddoc._id];
                continue;
            }
            ddocs.push(ddoc);
            canManage[ddoc._id] = udoc.hasPerm(PERM.PERM_EDIT_DOMAIN)
                || udoc.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN);
        }
        this.response.template = 'home_domain.html';
        this.response.body = { ddocs, dudict, canManage };
    }

    @param('id', Types.String)
    async postStar(domainId: string, id: string) {
        await user.setById(this.user._id, { pinnedDomains: [...this.user.pinnedDomains, id] });
        this.back({ star: true });
    }

    @param('id', Types.String)
    async postUnstar(domainId: string, id: string) {
        await user.setById(this.user._id, { pinnedDomains: this.user.pinnedDomains.filter((i) => i !== id) });
        this.back({ star: false });
    }
}

class HomeDomainCreateHandler extends Handler {
    async get() {
        this.response.template = 'domain_create.html';
    }

    @param('id', Types.DomainId)
    @param('name', Types.Title)
    @param('bulletin', Types.Content)
    @param('avatar', Types.Content, true)
    // eslint-disable-next-line @typescript-eslint/no-shadow
    async post(_: string, id: string, name: string, bulletin: string, avatar: string) {
        const doc = await domain.get(id);
        if (doc) throw new DomainAlreadyExistsError(id);
        avatar ||= this.user.avatar || `gravatar:${this.user.mail}`;
        const domainId = await domain.add(id, this.user._id, name, bulletin);
        // When this domain is deleted but previously added to user's list we shouldn't push it again
        const push = !this.user.pinnedDomains?.includes(domainId);
        await Promise.all([
            domain.edit(domainId, { avatar }),
            domain.setUserRole(domainId, this.user._id, 'root'),
            push
                ? user.setById(this.user._id, undefined, undefined, { pinnedDomains: domainId })
                : Promise.resolve(),
        ]);
        this.response.redirect = this.url('domain_dashboard', { domainId });
        this.response.body = { domainId };
    }
}

class HomeMessagesHandler extends Handler {
    async get() {
        // TODO(iceboy): projection, pagination.
        const messages = await message.getByUser(this.user._id);
        const uids = new Set<number>([
            ...messages.map((mdoc) => mdoc.from),
            ...messages.map((mdoc) => mdoc.to),
        ]);
        const udict = await user.getList('system', Array.from(uids));
        // TODO(twd2): improve here:
        const parsed = {};
        for (const m of messages) {
            const target = m.from === this.user._id ? m.to : m.from;
            parsed[target] ||= {
                _id: target,
                udoc: { ...udict[target], avatarUrl: avatar(udict[target].avatar) },
                messages: [],
            };
            parsed[target].messages.push(m);
        }
        await user.setById(this.user._id, { unreadMsg: 0 });
        this.response.body = { messages: parsed };
        this.response.template = 'home_messages.html';
    }

    @param('uid', Types.Int)
    @param('content', Types.Content)
    async postSend(domainId: string, uid: number, content: string) {
        this.checkPriv(PRIV.PRIV_SEND_MESSAGE);
        const udoc = await user.getById('system', uid);
        if (!udoc) throw new UserNotFoundError(uid);
        if (udoc.avatar) udoc.avatarUrl = avatar(udoc.avatar);
        const mdoc = await message.send(this.user._id, uid, content, message.FLAG_UNREAD);
        this.back({ mdoc, udoc });
    }

    @param('messageId', Types.ObjectId)
    async postDeleteMessage(domainId: string, messageId: ObjectId) {
        const msg = await message.get(messageId);
        if ([msg.from, msg.to].includes(this.user._id)) await message.del(messageId);
        else throw new PermissionError();
        this.back();
    }

    @param('messageId', Types.ObjectId)
    async postRead(domainId: string, messageId: ObjectId) {
        const msg = await message.get(messageId);
        if ([msg.from, msg.to].includes(this.user._id)) {
            await message.setFlag(messageId, message.FLAG_UNREAD);
        } else throw new PermissionError();
        this.back();
    }
}

class HomeMessagesConnectionHandler extends ConnectionHandler {
    category = '#message';

    @subscribe('user/message')
    async onMessageReceived(uid: number, mdoc: MessageDoc) {
        if (uid !== this.user._id) return;
        const udoc = (await user.getById(this.args.domainId, mdoc.from))!;
        udoc.avatarUrl = avatar(udoc.avatar, 64);
        this.send({ udoc, mdoc });
    }
}

export async function apply(ctx: Context) {
    ctx.on('handler/after', async (h) => {
        if (h.request.path === '/') {
            h.UiContext.spacename = 'homepage';
        }
    });
    ctx.inject(['geoip'], (g) => {
        geoip = g.geoip;
    });
    ctx.Route('homepage', '/', HomeHandler);
    ctx.Route('home_security', '/home/security', HomeSecurityHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_changemail_with_code', '/home/changeMail/:code', UserChangemailWithCodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('home_settings', '/home/settings/:category', HomeSettingsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('home_avatar', '/home/avatar', HomeAvatarHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('home_domain', '/home/domain', HomeDomainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('home_domain_create', '/home/domain/create', HomeDomainCreateHandler, PRIV.PRIV_CREATE_DOMAIN);
    ctx.Route('home_messages', '/home/messages', HomeMessagesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('home_messages_conn', '/home/messages-conn', HomeMessagesConnectionHandler, PRIV.PRIV_USER_PROFILE);
}
