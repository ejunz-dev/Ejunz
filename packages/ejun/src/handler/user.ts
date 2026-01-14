import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import moment from 'moment-timezone';
import { Binary } from 'mongodb';
import Schema from 'schemastery';
import { randomstring } from '@ejunz/utils';
import type { Context } from '../context';
import {
    AuthOperationError, BadRequestError, BlacklistedError, BuiltinLoginError,
    ForbiddenError, InvalidTokenError, NotFoundError,
    SystemError, UserAlreadyExistError, UserFacingError,
    UserNotFoundError, ValidationError, VerifyPasswordError,
} from '../error';
import { TokenDoc, Udoc, User } from '../interface';
import avatar from '../lib/avatar';
import { sendMail } from '../lib/mail';
import { verifyTFA } from '../lib/verifyTFA';
import BlackListModel from '../model/blacklist';
import { PERM, PRIV, STATUS } from '../model/builtin';
import domain from '../model/domain';
import * as document from '../model/document';
import * as node from '../model/node';
import * as mindmap from '../model/mindmap';
import * as oplog from '../model/oplog';
import ScheduleModel from '../model/schedule';
import system from '../model/system';
import token from '../model/token';
import user, { deleteUserCache } from '../model/user';
import db from '../service/db';
import {
    Handler, param, post, Query, Types,
} from '../service/server';

async function successfulAuth(this: Handler, udoc: User) {
    await user.setById(udoc._id, { loginat: new Date(), loginip: this.request.ip });
    this.context.EjunzContext.user = udoc;
    this.session.viewLang = '';
    this.session.uid = udoc._id;
    this.session.sudo = null;
    this.session.sudoUid = null;
    this.session.scope = PERM.PERM_ALL.toString();
    this.session.oauthBind = null;
    this.session.recreate = true;
}

class UserLoginHandler extends Handler {
    noCheckPermView = true;
    async prepare() {
        if (!system.get('server.login')) throw new BuiltinLoginError();
    }

    async get() {
        this.response.template = 'user_login.html';
    }

    @param('uname', Types.Username)
    @param('password', Types.Password)
    @param('rememberme', Types.Boolean)
    @param('redirect', Types.String, true)
    @param('tfa', Types.String, true)
    @param('authnChallenge', Types.String, true)
    async post(
        domainId: string, uname: string, password: string, rememberme = false, redirect = '',
        tfa = '', authnChallenge = '',
    ) {
        let udoc = await user.getByEmail(domainId, uname);
        udoc ||= await user.getByUname(domainId, uname);
        if (!udoc) throw new UserNotFoundError(uname);
        if (system.get('system.contestmode') && !udoc.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            if (udoc._loginip && udoc._loginip !== this.request.ip) throw new ValidationError('ip');
            if (system.get('system.contestmode') === 'strict') {
                const udocs = await user.getMulti({ loginip: this.request.ip, _id: { $ne: udoc._id } }).toArray();
                if (udocs.length) throw new ValidationError('ip');
            }
        }
        await Promise.all([
            this.limitRate('user_login', 60, 30),
            this.limitRate('user_login_id', 60, 5, uname),
            oplog.log(this, 'user.login', { redirect }),
        ]);
        if (udoc.tfa || udoc.authn) {
            if (udoc.tfa && tfa) {
                if (!verifyTFA(udoc._tfa, tfa)) throw new InvalidTokenError('2FA');
            } else if (udoc.authn && authnChallenge) {
                const challenge = await token.get(authnChallenge, token.TYPE_WEBAUTHN);
                if (!challenge || challenge.uid !== udoc._id) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_WEBAUTHN]);
                if (!challenge.verified) throw new ValidationError('challenge');
                await token.del(authnChallenge, token.TYPE_WEBAUTHN);
            } else throw new ValidationError('2FA', 'Authn');
        }
        await udoc.checkPassword(password);
        if (!udoc.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new BlacklistedError(uname, udoc.banReason);
        await successfulAuth.call(this, udoc);
        this.session.save = rememberme;
        this.response.redirect = redirect || ((this.request.referer || '/login').endsWith('/login')
            ? this.url('homepage') : this.request.referer);
    }
}

class UserSudoHandler extends Handler {
    async get() {
        if (!this.session.sudoArgs?.method) throw new ForbiddenError();
        this.response.template = 'user_sudo.html';
    }

    @param('password', Types.String, true)
    @param('tfa', Types.String, true)
    @param('authnChallenge', Types.String, true)
    async post(domainId: string, password = '', tfa = '', authnChallenge = '') {
        if (!this.session.sudoArgs?.method) throw new ForbiddenError();
        await Promise.all([
            this.limitRate('user_sudo', 60, 5, '{{user}}'),
            oplog.log(this, 'user.sudo', {}),
        ]);
        if (this.user.authn && authnChallenge) {
            const challenge = await token.get(authnChallenge, token.TYPE_WEBAUTHN);
            if (challenge?.uid !== this.user._id) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_WEBAUTHN]);
            if (!challenge.verified) throw new ValidationError('challenge');
            await token.del(authnChallenge, token.TYPE_WEBAUTHN);
        } else if (this.user.tfa && tfa) {
            if (!verifyTFA(this.user._tfa, tfa)) throw new InvalidTokenError('2FA');
        } else await this.user.checkPassword(password);
        this.session.sudo = Date.now();
        if (this.session.sudoArgs.method.toLowerCase() !== 'get') {
            this.response.template = 'user_sudo_redirect.html';
            this.response.body = this.session.sudoArgs;
        } else this.response.redirect = this.session.sudoArgs.redirect;
        this.session.sudoArgs.method = null;
    }
}

class UserTFAHandler extends Handler {
    noCheckPermView = true;

    @param('q', Types.String)
    async get({ }, q: string) {
        let udoc = await user.getByUname('system', q);
        udoc ||= await user.getByEmail('system', q);
        if (!udoc) this.response.body = { tfa: false, authn: false };
        else this.response.body = { tfa: udoc.tfa, authn: udoc.authn };
    }
}

class UserWebauthnHandler extends Handler {
    noCheckPermView = true;

    getAuthnHost() {
        return system.get('authn.host') && this.request.hostname.includes(system.get('authn.host'))
            ? system.get('authn.host') : this.request.hostname;
    }

    @param('uname', Types.Username, true)
    @param('login', Types.Boolean)
    async get(domainId: string, uname: string, login: boolean) {
        let allowCredentials = [];
        let uid = 0;
        if (!login) {
            const udoc = this.user._id ? this.user : ((await user.getByEmail(domainId, uname)) || await user.getByUname(domainId, uname));
            if (!udoc._id) throw new UserNotFoundError(uname || 'user');
            if (!udoc.authn) throw new AuthOperationError('authn', 'disabled');
            allowCredentials = udoc._authenticators.map((authenticator) => ({
                id: isoBase64URL.fromBuffer(authenticator.credentialID.buffer),
            }));
            uid = udoc._id;
        }
        const options = await generateAuthenticationOptions({
            allowCredentials,
            rpID: this.getAuthnHost(),
            userVerification: 'preferred',
        });
        await token.add(token.TYPE_WEBAUTHN, 60, { uid: login ? 'login' : uid }, options.challenge);
        this.session.challenge = options.challenge;
        this.response.body.authOptions = options;
    }

    async post({ domainId, result, redirect }) {
        const challenge = this.session.challenge;
        if (!challenge) throw new ForbiddenError();
        const tdoc = await token.get(challenge, token.TYPE_WEBAUTHN);
        if (!tdoc) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_WEBAUTHN]);
        const udoc = await (tdoc.uid === 'login'
            ? (async () => {
                const u = await user.coll.findOne({ 'authenticators.credentialID': Binary.createFromBase64(result.id) });
                return u ? await user.getById(domainId, u._id) : null;
            })()
            : user.getById(domainId, tdoc.uid));
        if (!udoc) throw new NotFoundError();
        const parseId = (id: Binary) => Buffer.from(id.toString('hex'), 'hex').toString('base64url');
        const authenticator = udoc._authenticators?.find((c) => parseId(c.credentialID) === result.id);
        if (!authenticator) throw new ValidationError('authenticator');
        const verification = await verifyAuthenticationResponse({
            response: result,
            expectedChallenge: challenge,
            expectedOrigin: this.request.headers.origin,
            expectedRPID: this.getAuthnHost(),
            credential: {
                ...authenticator,
                id: isoBase64URL.fromBuffer(authenticator.credentialID.buffer),
                publicKey: authenticator.credentialPublicKey.buffer,
            },
        }).catch(() => null);
        if (!verification?.verified) throw new ValidationError('authenticator');
        authenticator.counter = verification.authenticationInfo.newCounter;
        await user.setById(udoc._id, { authenticators: udoc._authenticators });
        if (tdoc.uid === 'login') {
            await successfulAuth.call(this, await user.getById(domainId, udoc._id));
            await token.del(challenge, token.TYPE_WEBAUTHN);
            this.response.redirect = redirect || ((this.request.referer || '/login').endsWith('/login')
                ? this.url('homepage') : this.request.referer);
        } else {
            await token.update(challenge, token.TYPE_WEBAUTHN, 60, { verified: true });
            this.back();
        }
    }
}

class UserLogoutHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.response.template = 'user_logout.html';
    }

    async post({ domainId }) {
        await successfulAuth.call(this, await user.getById(domainId, 0));
        this.response.redirect = '/';
    }
}

// rename to RegisterSendMailHandler
export class UserRegisterHandler extends Handler {
    noCheckPermView = true;
    async prepare() {
        if (!system.get('server.login')) throw new BuiltinLoginError();
    }

    async get() {
        this.response.template = 'user_register.html';
    }

    @post('mail', Types.Email)
    async post({ }, mail: string) {
        if (await user.getByEmail('system', mail)) throw new UserAlreadyExistError(mail);
        const mailDomain = mail.split('@')[1];
        if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);
        await Promise.all([
            this.limitRate('send_mail', 60, 1, mail),
            this.limitRate('send_mail', 3600, 30),
            oplog.log(this, 'user.register', {}),
        ]);
        const t = await token.add(
            token.TYPE_REGISTRATION,
            system.get('session.unsaved_expire_seconds'),
            {
                mail,
                redirect: this.domain.registerRedirect,
                identity: {
                    provider: 'mail',
                    platform: 'mail',
                    id: mail,
                },
            },
        );
        const prefix = this.domain.host
            ? `${this.domain.host instanceof Array ? this.domain.host[0] : this.domain.host}`
            : system.get('server.url');
        if (system.get('smtp.verify') && system.get('smtp.user')) {
            const m = await this.renderHTML('user_register_mail.html', {
                path: `/register/${t[0]}`,
                url_prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
            });
            await sendMail(mail, 'Sign Up', 'user_register_mail', m.toString());
            this.response.template = 'user_register_mail_sent.html';
            this.response.body = { mail };
        } else this.response.redirect = this.url('user_register_with_code', { code: t[0] });
    }
}

class UserRegisterWithCodeHandler extends Handler {
    noCheckPermView = true;
    tdoc: TokenDoc;

    @param('code', Types.String)
    async prepare({ }, code: string) {
        this.tdoc = await token.get(code, token.TYPE_REGISTRATION);
        if (!this.tdoc?.identity) {
            // prevent brute forcing tokens
            await this.limitRate('user_register_with_code', 60, 5);
            throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_REGISTRATION], code);
        }
    }

    async get() {
        this.response.template = 'user_register_with_code.html';
        this.response.body = this.tdoc;
    }

    @param('password', Types.Password)
    @param('verifyPassword', Types.Password)
    @param('uname', Types.Username, true)
    @param('code', Types.String)
    async post(
        domainId: string, password: string, verify: string,
        uname = '', code: string,
    ) {
        const provider = this.ctx.oauth.providers[this.tdoc.identity.provider];
        if (!provider) throw new SystemError(`OAuth provider ${this.tdoc.identity.provider} not found`);
        if (provider.lockUsername) uname = this.tdoc.identity.username;
        if (!Types.Username[1](uname)) throw new ValidationError('uname');
        if (password !== verify) throw new VerifyPasswordError();
        const randomEmail = `${randomstring(12)}@invalid.local`; // some random email to remove in the future
        const uid = await user.create(this.tdoc.mail || randomEmail, uname, password, undefined, this.request.ip);
        await token.del(code, token.TYPE_REGISTRATION);
        const [id, mailDomain] = this.tdoc.mail.split('@');
        const $set: any = this.tdoc.set || {};
        if (mailDomain === 'qq.com' && !Number.isNaN(+id)) $set.avatar = `qq:${id}`;
        if (this.session.viewLang) $set.viewLang = this.session.viewLang;
        if (Object.keys($set).length) await user.setById(uid, $set);
        if (Object.keys(this.tdoc.setInDomain || {}).length) await domain.setUserInDomain(domainId, uid, this.tdoc.setInDomain);
        await this.ctx.oauth.set(this.tdoc.identity.platform, this.tdoc.identity.id, uid);
        await successfulAuth.call(this, await user.getById(domainId, uid));
        this.response.redirect = this.tdoc.redirect || this.url('home_settings', { category: 'preference' });
    }
}

class UserLostPassHandler extends Handler {
    noCheckPermView = true;

    async get() {
        this.response.template = 'user_lostpass.html';
    }

    @param('mail', Types.Email)
    async post(domainId: string, mail: string) {
        if (!system.get('smtp.user')) throw new SystemError('Cannot send mail');
        const udoc = await user.getByEmail('system', mail);
        if (!udoc) throw new UserNotFoundError(mail);
        await Promise.all([
            this.limitRate('send_mail', 3600, 30),
            this.limitRate('send_mail', 60, 1, mail),
            oplog.log(this, 'user.lostpass', {}),
        ]);
        const [tid] = await token.add(
            token.TYPE_LOSTPASS,
            system.get('session.unsaved_expire_seconds'),
            { uid: udoc._id },
        );
        const prefix = this.domain.host
            ? `${this.domain.host instanceof Array ? this.domain.host[0] : this.domain.host}`
            : system.get('server.url');
        const m = await this.renderHTML('user_lostpass_mail.html', {
            url: `/lostpass/${tid}`,
            url_prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
            uname: udoc.uname,
        });
        await sendMail(mail, 'Lost Password', 'user_lostpass_mail', m.toString());
        this.response.template = 'user_lostpass_mail_sent.html';
    }
}

class UserLostPassWithCodeHandler extends Handler {
    noCheckPermView = true;

    async get({ domainId, code }) {
        const tdoc = await token.get(code, token.TYPE_LOSTPASS);
        if (!tdoc) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_LOSTPASS], code);
        const udoc = await user.getById(domainId, tdoc.uid);
        this.response.body = { uname: udoc.uname };
        this.response.template = 'user_lostpass_with_code.html';
    }

    @param('code', Types.String)
    @param('password', Types.Password)
    @param('verifyPassword', Types.Password)
    async post(domainId: string, code: string, password: string, verifyPassword: string) {
        const tdoc = await token.get(code, token.TYPE_LOSTPASS);
        if (!tdoc) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_LOSTPASS], code);
        if (password !== verifyPassword) throw new VerifyPasswordError();
        await user.setById(tdoc.uid, { authenticators: [], tfa: false });
        await user.setPassword(tdoc.uid, password);
        await token.del(code, token.TYPE_LOSTPASS);
        this.response.redirect = this.url('homepage');
    }
}

class UserDetailHandler extends Handler {
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        if (uid === 0) throw new UserNotFoundError(0);
        const isSelfProfile = this.user._id === uid;
        const [udoc, sdoc] = await Promise.all([
            user.getById(domainId, uid),
            token.getMostRecentSessionByUid(uid, ['createAt', 'updateAt']),
        ]);
        if (!udoc) throw new UserNotFoundError(uid);

        const dudict = await domain.getDictUserByDomainId(uid);
        const domainIds = Object.keys(dudict).filter(did => dudict[did].join);
        const domains = await Promise.all(
            domainIds.map(async (did) => {
                const ddoc = await domain.get(did);
                const dudoc = dudict[did];
                if (!ddoc) return null;
                let joinAt: Date | null = null;
                if (dudoc._id && dudoc._id.getTimestamp) {
                    joinAt = dudoc._id.getTimestamp();
                } else if (dudoc.createdAt) {
                    joinAt = dudoc.createdAt;
                } else if (dudoc.joinAt) {
                    joinAt = dudoc.joinAt;
                }
                const userCount = await domain.countUser(did);
                
                const independentNodeCount = await document.count(did, document.TYPE_NODE, { owner: uid });
                
                const mindMaps = await document.getMulti(did, document.TYPE_MINDMAP, { owner: uid })
                    .project({ nodes: 1, branchData: 1 })
                    .toArray();
                let mindMapNodeCount = 0;
                for (const mindMapDoc of mindMaps) {
                    const nodeIds = new Set<string>();
                    if (mindMapDoc.nodes && Array.isArray(mindMapDoc.nodes)) {
                        for (const node of mindMapDoc.nodes) {
                            if (node && node.id) {
                                nodeIds.add(node.id);
                            }
                        }
                    }
                    if (mindMapDoc.branchData && typeof mindMapDoc.branchData === 'object') {
                        for (const branch in mindMapDoc.branchData) {
                            const branchNodes = mindMapDoc.branchData[branch]?.nodes;
                            if (branchNodes && Array.isArray(branchNodes)) {
                                for (const node of branchNodes) {
                                    if (node && node.id) {
                                        nodeIds.add(node.id);
                                    }
                                }
                            }
                        }
                    }
                    mindMapNodeCount += nodeIds.size;
                }
                const totalNodeCount = independentNodeCount + mindMapNodeCount;
                
                const cardCount = await document.count(did, document.TYPE_CARD, { owner: uid });
                
                const cards = await document.getMulti(did, document.TYPE_CARD, { owner: uid })
                    .project({ problems: 1 })
                    .toArray();
                let problemCount = 0;
                for (const cardDoc of cards) {
                    if (cardDoc.problems && Array.isArray(cardDoc.problems)) {
                        problemCount += cardDoc.problems.length;
                    }
                }
                
                return {
                    id: did,
                    name: ddoc.name,
                    role: dudict[did].role,
                    avatar: ddoc.avatar || null,
                    avatarUrl: ddoc.avatar ? avatar(ddoc.avatar, 64) : '/img/team_avatar.png',
                    joinAt: joinAt,
                    userCount: userCount,
                    nodeCount: totalNodeCount,
                    cardCount: cardCount,
                    problemCount: problemCount,
                };
            })
        );
        const joinedDomains = domains.filter(d => d !== null);

        const contributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }> = [];
        const nodeCounts: Record<string, number> = {};
        const cardCounts: Record<string, number> = {};
        const problemCounts: Record<string, number> = {};
        
        const contributionDetails: Record<string, Array<{
            domainId: string;
            domainName: string;
            nodes: number;
            cards: number;
            problems: number;
            nodeStats: { created: number; modified: number; deleted: number };
            cardStats: { created: number; modified: number; deleted: number };
            problemStats: { created: number; modified: number; deleted: number };
        }>> = {};

        for (const did of domainIds) {
            const ddoc = await domain.get(did);
            const domainName = ddoc?.name || did;
            const independentNodes = await document.getMulti(did, document.TYPE_NODE, { owner: uid })
                .project({ createdAt: 1, updateAt: 1 })
                .toArray();
            for (const nodeDoc of independentNodes) {
                if (nodeDoc.createdAt) {
                    const createDate = moment.utc(nodeDoc.createdAt).format('YYYY-MM-DD');
                    const updateDate = nodeDoc.updateAt ? moment.utc(nodeDoc.updateAt).format('YYYY-MM-DD') : createDate;
                    const isCreated = createDate === updateDate && nodeDoc.updateAt && 
                        Math.abs(moment.utc(nodeDoc.updateAt).diff(moment.utc(nodeDoc.createdAt), 'minutes')) < 5;
                    
                    const date = isCreated ? createDate : updateDate;
                    nodeCounts[date] = (nodeCounts[date] || 0) + 1;
                    
                    if (!contributionDetails[date]) {
                        contributionDetails[date] = [];
                    }
                    let detail = contributionDetails[date].find(d => d.domainId === did);
                    if (!detail) {
                        detail = { 
                            domainId: did, 
                            domainName, 
                            nodes: 0, 
                            cards: 0, 
                            problems: 0,
                            nodeStats: { created: 0, modified: 0, deleted: 0 },
                            cardStats: { created: 0, modified: 0, deleted: 0 },
                            problemStats: { created: 0, modified: 0, deleted: 0 }
                        };
                        contributionDetails[date].push(detail);
                    }
                    detail.nodes += 1;
                    if (isCreated) {
                        detail.nodeStats.created += 1;
                    } else if (updateDate !== createDate) {
                        detail.nodeStats.modified += 1;
                    }
                }
            }

            const mindMaps = await document.getMulti(did, document.TYPE_MINDMAP, { owner: uid })
                .project({ nodes: 1, branchData: 1, updateAt: 1, createdAt: 1 })
                .toArray();
            for (const mindMapDoc of mindMaps) {
                let totalNodesInMindMap = 0;
                const nodeIds = new Set<string>();
                
                if (mindMapDoc.nodes && Array.isArray(mindMapDoc.nodes)) {
                    for (const node of mindMapDoc.nodes) {
                        if (node && node.id) {
                            nodeIds.add(node.id);
                        }
                    }
                }
                
                if (mindMapDoc.branchData && typeof mindMapDoc.branchData === 'object') {
                    for (const branch in mindMapDoc.branchData) {
                        const branchNodes = mindMapDoc.branchData[branch]?.nodes;
                        if (branchNodes && Array.isArray(branchNodes)) {
                            for (const node of branchNodes) {
                                if (node && node.id) {
                                    nodeIds.add(node.id);
                                }
                            }
                        }
                    }
                }
                
                totalNodesInMindMap = nodeIds.size;
                
                if (totalNodesInMindMap > 0) {
                    const date = mindMapDoc.updateAt 
                        ? moment.utc(mindMapDoc.updateAt).format('YYYY-MM-DD')
                        : (mindMapDoc.createdAt ? moment.utc(mindMapDoc.createdAt).format('YYYY-MM-DD') : null);
                    if (date) {
                        nodeCounts[date] = (nodeCounts[date] || 0) + totalNodesInMindMap;
                        
                        if (!contributionDetails[date]) {
                            contributionDetails[date] = [];
                        }
                    let detail = contributionDetails[date].find(d => d.domainId === did);
                    if (!detail) {
                        detail = { 
                            domainId: did, 
                            domainName, 
                            nodes: 0, 
                            cards: 0, 
                            problems: 0,
                            nodeStats: { created: 0, modified: 0, deleted: 0 },
                            cardStats: { created: 0, modified: 0, deleted: 0 },
                            problemStats: { created: 0, modified: 0, deleted: 0 }
                        };
                        contributionDetails[date].push(detail);
                    }
                    detail.nodes += totalNodesInMindMap;
                    const createDate = mindMapDoc.createdAt ? moment.utc(mindMapDoc.createdAt).format('YYYY-MM-DD') : null;
                    const isCreated = createDate === date && mindMapDoc.updateAt && 
                        Math.abs(moment.utc(mindMapDoc.updateAt).diff(moment.utc(mindMapDoc.createdAt), 'minutes')) < 5;
                    if (isCreated) {
                        detail.nodeStats.created += totalNodesInMindMap;
                    } else if (createDate && createDate !== date) {
                        detail.nodeStats.modified += totalNodesInMindMap;
                    }
                    }
                }
            }

            const cards = await document.getMulti(did, document.TYPE_CARD, { owner: uid })
                .project({ createdAt: 1, updateAt: 1, problems: 1 })
                .toArray();
            for (const cardDoc of cards) {
                if (cardDoc.createdAt) {
                    const createDate = moment.utc(cardDoc.createdAt).format('YYYY-MM-DD');
                    const updateDate = cardDoc.updateAt ? moment.utc(cardDoc.updateAt).format('YYYY-MM-DD') : createDate;
                    const isCreated = createDate === updateDate && cardDoc.updateAt && 
                        Math.abs(moment.utc(cardDoc.updateAt).diff(moment.utc(cardDoc.createdAt), 'minutes')) < 5;
                    
                    const date = isCreated ? createDate : updateDate;
                    cardCounts[date] = (cardCounts[date] || 0) + 1;
                    
                    if (!contributionDetails[date]) {
                        contributionDetails[date] = [];
                    }
                    let detail = contributionDetails[date].find(d => d.domainId === did);
                    if (!detail) {
                        detail = { 
                            domainId: did, 
                            domainName, 
                            nodes: 0, 
                            cards: 0, 
                            problems: 0,
                            nodeStats: { created: 0, modified: 0, deleted: 0 },
                            cardStats: { created: 0, modified: 0, deleted: 0 },
                            problemStats: { created: 0, modified: 0, deleted: 0 }
                        };
                        contributionDetails[date].push(detail);
                    }
                    detail.cards += 1;
                    if (isCreated) {
                        detail.cardStats.created += 1;
                    } else if (updateDate !== createDate) {
                        detail.cardStats.modified += 1;
                    }
                    
                    if (cardDoc.problems && Array.isArray(cardDoc.problems)) {
                        const problemCount = cardDoc.problems.length;
                        problemCounts[date] = (problemCounts[date] || 0) + problemCount;
                        detail.problems += problemCount;
                        detail.problemStats.created += problemCount;
                    }
                }
            }
        }

        const oplogColl = db.collection('oplog');
        const deleteStats: Record<string, Record<string, { nodes: number; cards: number; problems: number }>> = {};
        
        for (const did of domainIds) {
            const deleteOps = await oplogColl.find({
                operator: uid,
                domainId: did,
                type: { $regex: /delete/i },
            }).toArray();
            
            for (const op of deleteOps) {
                const deleteDate = moment.utc(op.time).format('YYYY-MM-DD');
                if (!deleteStats[deleteDate]) {
                    deleteStats[deleteDate] = {};
                }
                if (!deleteStats[deleteDate][did]) {
                    deleteStats[deleteDate][did] = { nodes: 0, cards: 0, problems: 0 };
                }
                
                const opType = op.type?.toLowerCase() || '';
                const args = op.args || {};
                const json = op.json || {};
                
                if (opType.includes('node') || opType.includes('mindmap.node') || args.nodeId || json.nodeId) {
                    deleteStats[deleteDate][did].nodes += 1;
                } else if (opType.includes('card') || args.cardId || json.cardId || args.cid || json.cid) {
                    deleteStats[deleteDate][did].cards += 1;
                    if (args.problems || json.problems) {
                        const problemCount = Array.isArray(args.problems || json.problems) 
                            ? (args.problems || json.problems).length 
                            : 0;
                        deleteStats[deleteDate][did].problems += problemCount;
                    }
                } else if (opType.includes('problem') || args.problemId || json.problemId || args.pid || json.pid) {
                    deleteStats[deleteDate][did].problems += 1;
                }
            }
        }
        
        for (const date of Object.keys(deleteStats)) {
            if (!contributionDetails[date]) {
                contributionDetails[date] = [];
            }
            for (const did of Object.keys(deleteStats[date])) {
                const ddoc = await domain.get(did);
                const domainName = ddoc?.name || did;
                let detail = contributionDetails[date].find(d => d.domainId === did);
                if (!detail) {
                    detail = { 
                        domainId: did, 
                        domainName, 
                        nodes: 0, 
                        cards: 0, 
                        problems: 0,
                        nodeStats: { created: 0, modified: 0, deleted: 0 },
                        cardStats: { created: 0, modified: 0, deleted: 0 },
                        problemStats: { created: 0, modified: 0, deleted: 0 }
                    };
                    contributionDetails[date].push(detail);
                }
                const stats = deleteStats[date][did];
                detail.nodeStats.deleted += stats.nodes;
                detail.cardStats.deleted += stats.cards;
                detail.problemStats.deleted += stats.problems;
            }
        }

        const allDates = new Set([
            ...Object.keys(nodeCounts),
            ...Object.keys(cardCounts),
            ...Object.keys(problemCounts),
            ...Object.keys(contributionDetails),
            ...Object.keys(deleteStats)
        ]);
        
        for (const date of allDates) {
            const nodeCount = nodeCounts[date] || 0;
            const cardCount = cardCounts[date] || 0;
            const problemCount = problemCounts[date] || 0;
            
            let finalNodeCount = nodeCount;
            let finalCardCount = cardCount;
            let finalProblemCount = problemCount;
            
            if (contributionDetails[date] && nodeCount === 0 && cardCount === 0 && problemCount === 0) {
                const details = contributionDetails[date];
                for (const detail of details) {
                    finalNodeCount += detail.nodes || 0;
                    finalCardCount += detail.cards || 0;
                    finalProblemCount += detail.problems || 0;
                }
            }
            
            // 只有当有数据时才添加到 contributions
            if (finalNodeCount > 0) {
                contributions.push({ date, type: 'node', count: finalNodeCount });
            }
            if (finalCardCount > 0) {
                contributions.push({ date, type: 'card', count: finalCardCount });
            }
            if (finalProblemCount > 0) {
                contributions.push({ date, type: 'problem', count: finalProblemCount });
            }
        }

        let totalNodes = 0;
        let totalCards = 0;
        let totalProblems = 0;
        
        for (const date of Object.keys(contributionDetails)) {
            const details = contributionDetails[date];
            for (const detail of details) {
                totalNodes += detail.nodes || 0;
                totalCards += detail.cards || 0;
                totalProblems += detail.problems || 0;
            }
        }

        const consumptions: Array<{ date: string; type: 'node' | 'card' | 'problem' | 'practice'; count: number }> = [];
        const consumptionNodeCounts: Record<string, number> = {};
        const consumptionCardCounts: Record<string, number> = {};
        const consumptionProblemCounts: Record<string, number> = {};
        const consumptionPracticeCounts: Record<string, number> = {};
        let totalConsumptionTime = 0;
        
        const consumptionDetails: Record<string, Array<{
            domainId: string;
            domainName: string;
            nodes: number;
            cards: number;
            problems: number;
            practices: number;
            totalTime: number;
        }>> = {};

        const learnResultColl = this.ctx.db.db.collection('learn_result');
        const allResultRecords = await learnResultColl.find({
            userId: uid,
        }).toArray();

        const learnProgressColl = this.ctx.db.db.collection('learn_progress');
        const allProgressRecords = await learnProgressColl.find({
            userId: uid,
        }).toArray();

        const resultStatsByDate: Record<string, Record<string, {
            totalTime: number;
            nodes: Set<string>;
            cards: Set<string>;
            problems: Set<string>;
        }>> = {};

        for (const result of allResultRecords) {
            if (result.createdAt) {
                const date = moment.utc(result.createdAt).format('YYYY-MM-DD');
                const did = result.domainId || '';
                if (!resultStatsByDate[date]) {
                    resultStatsByDate[date] = {};
                }
                if (!resultStatsByDate[date][did]) {
                    resultStatsByDate[date][did] = {
                        totalTime: 0,
                        nodes: new Set<string>(),
                        cards: new Set<string>(),
                        problems: new Set<string>(),
                    };
                }
                const stats = resultStatsByDate[date][did];
                if (result.totalTime) {
                    stats.totalTime += result.totalTime || 0;
                }
                if (result.nodeId) {
                    stats.nodes.add(result.nodeId);
                }
                if (result.cardId) {
                    stats.cards.add(result.cardId.toString());
                }
                if (result.answerHistory && Array.isArray(result.answerHistory)) {
                    for (const history of result.answerHistory) {
                        if (history.problemId) {
                            stats.problems.add(history.problemId);
                        }
                    }
                }
            }
        }

        const progressStatsByDate: Record<string, Record<string, Set<string>>> = {};
        for (const progress of allProgressRecords) {
            if (progress.passedAt) {
                const date = moment.utc(progress.passedAt).format('YYYY-MM-DD');
                const did = progress.domainId || '';
                if (!progressStatsByDate[date]) {
                    progressStatsByDate[date] = {};
                }
                if (!progressStatsByDate[date][did]) {
                    progressStatsByDate[date][did] = new Set<string>();
                }
                if (progress.cardId) {
                    progressStatsByDate[date][did].add(progress.cardId.toString());
                }
            }
        }

        for (const date of Object.keys(resultStatsByDate)) {
            for (const did of Object.keys(resultStatsByDate[date])) {
                if (!consumptionDetails[date]) {
                    consumptionDetails[date] = [];
                }
                let detail = consumptionDetails[date].find(d => d.domainId === did);
                if (!detail) {
                    const ddoc = await domain.get(did);
                    const domainName = ddoc?.name || did;
                    detail = { domainId: did, domainName, nodes: 0, cards: 0, problems: 0, practices: 0, totalTime: 0 };
                    consumptionDetails[date].push(detail);
                }
                const stats = resultStatsByDate[date][did];
                detail.totalTime = stats.totalTime;
                detail.nodes = stats.nodes.size;
                detail.cards = stats.cards.size;
                detail.problems = stats.problems.size;
                if (progressStatsByDate[date] && progressStatsByDate[date][did]) {
                    detail.practices = progressStatsByDate[date][did].size;
                }
                consumptionNodeCounts[date] = (consumptionNodeCounts[date] || 0) + detail.nodes;
                consumptionCardCounts[date] = (consumptionCardCounts[date] || 0) + detail.cards;
                consumptionProblemCounts[date] = (consumptionProblemCounts[date] || 0) + detail.problems;
                consumptionPracticeCounts[date] = (consumptionPracticeCounts[date] || 0) + detail.practices;
                totalConsumptionTime += detail.totalTime;
            }
        }

        const allConsumptionDates = new Set([
            ...Object.keys(consumptionNodeCounts),
            ...Object.keys(consumptionCardCounts),
            ...Object.keys(consumptionProblemCounts),
            ...Object.keys(consumptionPracticeCounts),
        ]);
        for (const date of allConsumptionDates) {
            if (consumptionNodeCounts[date]) {
                consumptions.push({ date, type: 'node', count: consumptionNodeCounts[date] });
            }
            if (consumptionCardCounts[date]) {
                consumptions.push({ date, type: 'card', count: consumptionCardCounts[date] });
            }
            if (consumptionProblemCounts[date]) {
                consumptions.push({ date, type: 'problem', count: consumptionProblemCounts[date] });
            }
            if (consumptionPracticeCounts[date]) {
                consumptions.push({ date, type: 'practice', count: consumptionPracticeCounts[date] });
            }
        }

        const totalConsumptionNodes = Object.values(consumptionNodeCounts).reduce((sum, count) => sum + count, 0);
        const totalConsumptionCards = Object.values(consumptionCardCounts).reduce((sum, count) => sum + count, 0);
        const totalConsumptionProblems = Object.values(consumptionProblemCounts).reduce((sum, count) => sum + count, 0);
        const totalConsumptionTimeInSeconds = Math.round(totalConsumptionTime / 1000);

        this.response.template = 'user_detail.html';
        this.response.body = {
            isSelfProfile, udoc, sdoc,
            joinedDomains,
            contributions,
            contributionDetails,
            consumptions,
            consumptionDetails,
            stats: {
                totalNodes,
                totalCards,
                totalProblems,
            },
            consumptionStats: {
                totalNodes: totalConsumptionNodes,
                totalCards: totalConsumptionCards,
                totalProblems: totalConsumptionProblems,
                totalTime: totalConsumptionTimeInSeconds,
            },
        };

        this.UiContext.joinedDomains = joinedDomains;
        this.UiContext.contributions = contributions;
        this.UiContext.contributionDetails = contributionDetails;
        this.UiContext.consumptions = consumptions;
        this.UiContext.consumptionDetails = consumptionDetails;
        this.UiContext.stats = {
            totalNodes,
            totalCards,
            totalProblems,
        };
        this.UiContext.consumptionStats = {
            totalNodes: totalConsumptionNodes,
            totalCards: totalConsumptionCards,
            totalProblems: totalConsumptionProblems,
            totalTime: totalConsumptionTimeInSeconds,
        };

        this.UiContext.extraTitleContent = udoc.uname;
    }
}

class UserContributionDetailHandler extends Handler {
    @param('uid', Types.Int)
    @param('date', Types.String)
    @param('domainId', Types.String)
    async get(domainId: string, uid: number, date: string, targetDomainId: string) {
        if (uid === 0) throw new UserNotFoundError(0);
        const udoc = await user.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new ValidationError('Invalid date format');
        }

        const targetDomain = await domain.get(targetDomainId);
        if (!targetDomain) {
            throw new NotFoundError(`Domain ${targetDomainId} not found`);
        }

        const dudict = await domain.getDictUserByDomainId(uid);
        if (!dudict[targetDomainId]?.join) {
            throw new ForbiddenError('User has not joined this domain');
        }

        const contributions: {
            nodes: Array<{ id: string; name: string; createdAt: Date; type: 'independent' | 'mindmap' }>;
            cards: Array<{ docId: string; title: string; nodeId: string; createdAt: Date; problems?: number }>;
            problems: Array<{ cardId: string; cardTitle: string; pid: string; stem: string; createdAt: Date }>;
        } = {
            nodes: [],
            cards: [],
            problems: [],
        };

        const independentNodes = await document.getMulti(targetDomainId, document.TYPE_NODE, { owner: uid })
            .project({ nid: 1, name: 1, createdAt: 1 })
            .toArray();
        for (const nodeDoc of independentNodes) {
            if (nodeDoc.createdAt) {
                const nodeDate = moment.utc(nodeDoc.createdAt).format('YYYY-MM-DD');
                if (nodeDate === date) {
                    contributions.nodes.push({
                        id: nodeDoc.nid?.toString() || nodeDoc._id.toString(),
                        name: nodeDoc.name || this.translate('Unnamed Node'),
                        createdAt: nodeDoc.createdAt,
                        type: 'independent',
                    });
                }
            }
        }

        const mindMaps = await document.getMulti(targetDomainId, document.TYPE_MINDMAP, { owner: uid })
            .project({ docId: 1, title: 1, nodes: 1, branchData: 1, updateAt: 1, createdAt: 1 })
            .toArray();
        for (const mindMapDoc of mindMaps) {
            const mapDate = mindMapDoc.updateAt 
                ? moment.utc(mindMapDoc.updateAt).format('YYYY-MM-DD')
                : (mindMapDoc.createdAt ? moment.utc(mindMapDoc.createdAt).format('YYYY-MM-DD') : null);
            
            if (mapDate === date) {
                const nodeIds = new Set<string>();
                const nodeMap = new Map<string, any>();
                
                if (mindMapDoc.nodes && Array.isArray(mindMapDoc.nodes)) {
                    for (const node of mindMapDoc.nodes) {
                        if (node && node.id) {
                            nodeIds.add(node.id);
                            nodeMap.set(node.id, node);
                        }
                    }
                }
                
                if (mindMapDoc.branchData && typeof mindMapDoc.branchData === 'object') {
                    for (const branch in mindMapDoc.branchData) {
                        const branchNodes = mindMapDoc.branchData[branch]?.nodes;
                        if (branchNodes && Array.isArray(branchNodes)) {
                            for (const node of branchNodes) {
                                if (node && node.id) {
                                    nodeIds.add(node.id);
                                    if (!nodeMap.has(node.id)) {
                                        nodeMap.set(node.id, node);
                                    }
                                }
                            }
                        }
                    }
                }
                
                for (const nodeId of nodeIds) {
                    const node = nodeMap.get(nodeId);
                    contributions.nodes.push({
                        id: nodeId,
                        name: node?.text || node?.name || this.translate('Unnamed Node'),
                        createdAt: mindMapDoc.updateAt || mindMapDoc.createdAt,
                        type: 'mindmap',
                    });
                }
            }
        }

        const cards = await document.getMulti(targetDomainId, document.TYPE_CARD, { owner: uid })
            .project({ docId: 1, title: 1, nodeId: 1, createdAt: 1, problems: 1 })
            .toArray();
            for (const cardDoc of cards) {
                if (cardDoc.createdAt) {
                    const cardDate = moment.utc(cardDoc.createdAt).format('YYYY-MM-DD');
                if (cardDate === date) {
                    contributions.cards.push({
                        docId: cardDoc.docId.toString(),
                        title: cardDoc.title || this.translate('Unnamed Card'),
                        nodeId: cardDoc.nodeId || '',
                        createdAt: cardDoc.createdAt,
                        problems: cardDoc.problems?.length || 0,
                    });

                    if (cardDoc.problems && Array.isArray(cardDoc.problems)) {
                        for (const problem of cardDoc.problems) {
                            contributions.problems.push({
                                cardId: cardDoc.docId.toString(),
                                cardTitle: cardDoc.title || this.translate('Unnamed Card'),
                                pid: problem.pid || '',
                                stem: problem.stem || this.translate('No stem'),
                                createdAt: cardDoc.createdAt,
                            });
                        }
                    }
                }
            }
        }

        const mindMap = await mindmap.MindMapModel.getByDomain(targetDomainId);

        this.response.template = 'user_contribution_detail.html';
        this.response.body = {
            udoc,
            targetDomain,
            date,
            contributions,
            mindMapDocId: mindMap?.docId,
        };

        this.UiContext.extraTitleContent = this.translate('Contributions on {0} in {1}').format(date, targetDomain.name);
    }
}

class UserConsumptionDetailHandler extends Handler {
    @param('uid', Types.Int)
    @param('date', Types.String)
    @param('domainId', Types.String)
    async get(domainId: string, uid: number, date: string, targetDomainId: string) {
        if (uid === 0) throw new UserNotFoundError(0);
        const udoc = await user.getById(domainId, uid);
        if (!udoc) throw new UserNotFoundError(uid);
        const targetDomain = await domain.get(targetDomainId);
        if (!targetDomain) throw new NotFoundError('Domain not found');

        const learnProgressColl = this.ctx.db.db.collection('learn_progress');
        const learnResultsColl = this.ctx.db.db.collection('learn_result');

        const startOfDay = moment.utc(date).startOf('day').toDate();
        const endOfDay = moment.utc(date).endOf('day').toDate();

        const progressRecords = await learnProgressColl.find({
            domainId: targetDomainId,
            userId: uid,
            passedAt: { $gte: startOfDay, $lte: endOfDay },
        }).toArray();

        const resultRecords = await learnResultsColl.find({
            domainId: targetDomainId,
            userId: uid,
            createdAt: { $gte: startOfDay, $lte: endOfDay },
        }).toArray();

        const mindMap = await mindmap.MindMapModel.getByDomain(targetDomainId);
        const mindMapDocId = mindMap?.docId;

        const contributions: {
            nodes: Array<{ id: string; name: string; createdAt: Date; type: string }>;
            cards: Array<{ docId: string; title: string; nodeId: string; createdAt: Date; totalTime?: number }>;
            problems: Array<{ cardId: string; cardTitle: string; pid: string; stem: string; createdAt: Date; totalTime?: number }>;
            practices: Array<{ cardId: string; cardTitle: string; nodeId: string; passedAt: Date; totalTime?: number }>;
        } = {
            nodes: [],
            cards: [],
            problems: [],
            practices: [],
        };

        const nodeMap = new Map<string, any>();
        const cardMap = new Map<string, any>();

        for (const result of resultRecords) {
            if (result.nodeId) {
                if (!nodeMap.has(result.nodeId)) {
                    const mindMapNodes = mindMap ? (mindMap.nodes || []).filter((n: any) => n.id === result.nodeId) : [];
                    const nodeData = mindMapNodes[0] || { id: result.nodeId, text: result.nodeId };
                    nodeMap.set(result.nodeId, nodeData);
                }
                const node = nodeMap.get(result.nodeId);
                contributions.nodes.push({
                    id: result.nodeId,
                    name: node.text || this.translate('Unnamed Node'),
                    createdAt: result.createdAt,
                    type: 'mindmap',
                });
            }

            if (result.cardId) {
                const cardIdStr = result.cardId.toString();
                if (!cardMap.has(cardIdStr)) {
                    const card = await document.get(targetDomainId, document.TYPE_CARD, result.cardId);
                    if (card) {
                        cardMap.set(cardIdStr, card);
                    }
                }
                const card = cardMap.get(cardIdStr);
                if (card) {
                    contributions.cards.push({
                        docId: cardIdStr,
                        title: card.title || this.translate('Unnamed Card'),
                        nodeId: result.nodeId || '',
                        createdAt: result.createdAt,
                        totalTime: result.totalTime,
                    });

                    if (result.answerHistory && Array.isArray(result.answerHistory)) {
                        const problemTimeMap = new Map<string, number>();
                        for (const history of result.answerHistory) {
                            if (history.problemId) {
                                const problemId = history.problemId;
                                const timeSpent = history.timeSpent || 0;
                                problemTimeMap.set(problemId, (problemTimeMap.get(problemId) || 0) + timeSpent);
                            }
                        }
                        const cardDoc = await document.get(targetDomainId, document.TYPE_CARD, result.cardId);
                        if (cardDoc && cardDoc.problems) {
                            for (const [problemId, totalTime] of problemTimeMap.entries()) {
                                const problem = cardDoc.problems.find((p: any) => p.pid === problemId);
                                if (problem) {
                                    contributions.problems.push({
                                        cardId: cardIdStr,
                                        cardTitle: card.title || this.translate('Unnamed Card'),
                                        pid: problemId,
                                        stem: problem.stem || this.translate('No stem'),
                                        createdAt: result.createdAt,
                                        totalTime: totalTime,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        for (const progress of progressRecords) {
            if (progress.passedAt) {
                const passedDate = moment.utc(progress.passedAt).format('YYYY-MM-DD');
                if (progress.cardId) {
                    const cardIdStr = progress.cardId.toString();
                    if (!cardMap.has(cardIdStr)) {
                        const card = await document.get(targetDomainId, document.TYPE_CARD, progress.cardId);
                        if (card) {
                            cardMap.set(cardIdStr, card);
                        }
                    }
                    const card = cardMap.get(cardIdStr);
                    if (card) {
                        const resultForPractice = resultRecords.find(r => 
                            r.cardId && r.cardId.toString() === cardIdStr &&
                            moment.utc(r.createdAt).format('YYYY-MM-DD') === passedDate
                        );
                        contributions.practices.push({
                            cardId: cardIdStr,
                            cardTitle: card.title || this.translate('Unnamed Card'),
                            nodeId: progress.nodeId || '',
                            passedAt: progress.passedAt,
                            totalTime: resultForPractice?.totalTime,
                        });
                    }
                }
            }
        }

        let totalTimeInMilliseconds = 0;
        const cardTimeMap = new Map<string, number>();
        for (const card of contributions.cards) {
            if (card.totalTime) {
                const currentTime = cardTimeMap.get(card.docId) || 0;
                cardTimeMap.set(card.docId, currentTime + card.totalTime);
            }
        }
        for (const practice of contributions.practices) {
            if (practice.totalTime) {
                const currentTime = cardTimeMap.get(practice.cardId) || 0;
                cardTimeMap.set(practice.cardId, currentTime + practice.totalTime);
            }
        }
        for (const time of cardTimeMap.values()) {
            totalTimeInMilliseconds += time;
        }

        this.response.template = 'user_consumption_detail.html';
        this.response.body = {
            udoc,
            targetDomain,
            date,
            contributions,
            mindMapDocId: mindMap?.docId,
            totalTimeInSeconds: Math.round(totalTimeInMilliseconds / 1000),
        };

        this.UiContext.extraTitleContent = this.translate('Consumption on {0} in {1}').format(date, targetDomain.name);
    }
}

class UserDeleteHandler extends Handler {
    async post({ password }) {
        await this.user.checkPassword(password);
        const tid = await ScheduleModel.add({
            executeAfter: moment().add(7, 'days').toDate(),
            type: 'script',
            id: 'deleteUser',
            args: { uid: this.user._id },
        });
        await user.setById(this.user._id, { del: tid });
        this.response.template = 'user_delete_pending.html';
    }
}

class OauthHandler extends Handler {
    noCheckPermView = true;

    @param('type', Types.Key)
    async get(domainId: string, type: string) {
        await this.ctx.oauth.providers[type]?.get.call(this);
    }
}

class OauthCallbackHandler extends Handler {
    noCheckPermView = true;

    async get(args: any) {
        const provider = this.ctx.oauth.providers[args.type];
        if (!provider) throw new UserFacingError('Oauth type');
        const r = await provider.callback.call(this, args);
        if (this.session.oauthBind === args.type) {
            delete this.session.oauthBind;
            const existing = await this.ctx.oauth.get(args.type, r._id);
            if (existing && existing !== this.user._id) {
                throw new BadRequestError('Already binded to another account');
            }
            this.response.redirect = '/home/security';
            if (existing !== this.user._id) await this.ctx.oauth.set(args.type, r._id, this.user._id);
            return;
        }

        const uid = await this.ctx.oauth.get(args.type, r._id) || await this.ctx.oauth.get('mail', r.email);
        if (uid) {
            await successfulAuth.call(this, await user.getById('system', uid));
            this.response.redirect = '/';
            return;
        }
        if (!provider.canRegister) throw new ForbiddenError('No binded account found');
        this.checkPriv(PRIV.PRIV_REGISTER_USER);
        let username = '';
        r.uname ||= [];
        const mailDomain = r.email.split('@')[1];
        if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);
        for (const uname of r.uname) {
            // eslint-disable-next-line no-await-in-loop
            const nudoc = await user.getByUname('system', uname);
            if (!nudoc) {
                username = uname;
                break;
            }
        }
        const set: Partial<Udoc> = { ...r.set };
        if (r.bio) set.bio = r.bio;
        if (r.viewLang) set.viewLang = r.viewLang;
        if (r.avatar) set.avatar = r.avatar;
        const [t] = await token.add(
            token.TYPE_REGISTRATION,
            system.get('session.unsaved_expire_seconds'),
            {
                mail: r.email,
                username,
                redirect: this.domain.registerRedirect,
                set,
                setInDomain: r.setInDomain,
                identity: {
                    provider: args.type,
                    platform: args.type,
                    id: r._id,
                },
            },
        );
        this.response.redirect = this.url('user_register_with_code', { code: t });
    }
}

class ContestModeHandler extends Handler {
    async get() {
        const bindings = await user.getMulti({ loginip: { $exists: true } })
            .project<{ _id: number, loginip: string }>({ _id: 1, loginip: 1 }).toArray();
        this.response.body = { bindings };
        this.response.template = 'contest_mode.html';
    }

    @param('uid', Types.Int, true)
    async postReset(domainId: string, uid: number) {
        if (uid) await user.setById(uid, {}, { loginip: '' });
        else {
            await user.coll.updateMany({}, { $unset: { loginip: 1 } });
            deleteUserCache(true);
        }
    }
}

export const inject = ['oauth'];

const UserApi = {
    user: Query(Schema.object({
        id: Schema.number().step(1),
        uname: Schema.string(),
        mail: Schema.string(),
        domainId: Schema.string().required(),
    }), (c, arg) => {
        if (arg.id) return user.getById(arg.domainId, arg.id);
        if (arg.mail) return user.getByEmail(arg.domainId, arg.mail);
        if (arg.uname) return user.getByUname(arg.domainId, arg.uname);
        return user.getById(arg.domainId, c.user._id);
    }),
    users: Query(Schema.object({
        ids: Schema.array(Schema.number().step(1)),
        auto: Schema.array(Schema.string()),
        search: Schema.string(),
        limit: Schema.number().step(1),
        exact: Schema.boolean(),
    }), async (c, arg) => {
        const auto = (arg.ids?.length && arg.ids) || arg.auto || [];
        if (auto.length) {
            const maybeId = auto.filter((i) => !Number.isNaN(+i));
            const result = [];
            if (maybeId.length) {
                const udocs = await user.getList(arg.domainId, maybeId.map((i) => +i));
                for (const i in udocs) udocs[i].avatarUrl = avatar(udocs[i].avatar);
                result.push(...Object.values(udocs));
            }
            const notFound = auto.filter((i) => !result.find((j) => j._id === +i));
            if (notFound.length > 50) return result; // reject if too many
            for (const i of notFound) {
                // eslint-disable-next-line no-await-in-loop
                const udoc = await user.getByUname(arg.domainId, i.toString()) || await user.getByEmail(arg.domainId, i.toString());
                if (udoc) result.push(udoc);
            }
            return result;
        }
        if (!arg.search) return [];
        const udoc = await user.getById(arg.domainId, +arg.search)
            || await user.getByUname(arg.domainId, arg.search)
            || await user.getByEmail(arg.domainId, arg.search);
        const udocs: User[] = arg.exact
            ? []
            : await user.getPrefixList(arg.domainId, arg.search, Math.min(arg.limit || 10, 10));
        if (udoc && !udocs.find((i) => i._id === udoc._id)) {
            udocs.pop();
            udocs.unshift(udoc);
        }
        for (const i in udocs) {
            udocs[i].avatarUrl = avatar(udocs[i].avatar);
        }
        return udocs;
    }),
} as const;

declare module '@ejunz/framework' {
    interface Apis {
        user: typeof UserApi;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('user_login', '/login', UserLoginHandler);
    ctx.Route('user_oauth', '/oauth/:type/login', OauthHandler);
    ctx.Route('user_sudo', '/user/sudo', UserSudoHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_tfa', '/user/tfa', UserTFAHandler);
    ctx.Route('user_webauthn', '/user/webauthn', UserWebauthnHandler);
    ctx.Route('user_oauth_callback', '/oauth/:type/callback', OauthCallbackHandler);
    ctx.Route('user_register', '/register', UserRegisterHandler, PRIV.PRIV_REGISTER_USER);
    ctx.Route('user_register_with_code', '/register/:code', UserRegisterWithCodeHandler, PRIV.PRIV_REGISTER_USER);
    ctx.Route('user_logout', '/logout', UserLogoutHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_lostpass', '/lostpass', UserLostPassHandler);
    ctx.Route('user_lostpass_with_code', '/lostpass/:code', UserLostPassWithCodeHandler);
    ctx.Route('user_delete', '/user/delete', UserDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_detail', '/user/:uid', UserDetailHandler);
    ctx.Route('user_contribution_detail', '/user/:uid/contributions/:date/:domainId', UserContributionDetailHandler);
    ctx.Route('user_consumption_detail', '/user/:uid/consumption/:date/:domainId', UserConsumptionDetailHandler);
    if (system.get('server.contestmode')) {
        ctx.Route('contest_mode', '/contestmode', ContestModeHandler, PRIV.PRIV_EDIT_SYSTEM);
    }
    ctx.oauth.provide('mail', {
        text: 'Mail',
        name: 'mail',
        hidden: true,
        async get() {
            throw new NotFoundError();
        },
        async callback() {
            throw new NotFoundError();
        },
    });
    await ctx.inject(['api'], ({ api }) => {
        api.provide(UserApi);
    });
}