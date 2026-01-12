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

        // 获取用户加入的域
        const dudict = await domain.getDictUserByDomainId(uid);
        const domainIds = Object.keys(dudict).filter(did => dudict[did].join);
        const domains = await Promise.all(
            domainIds.map(async (did) => {
                const ddoc = await domain.get(did);
                return ddoc ? { id: did, name: ddoc.name, role: dudict[did].role } : null;
            })
        );
        const joinedDomains = domains.filter(d => d !== null);

        // 获取用户创建的 node 和 card（跨所有域）
        const contributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }> = [];
        const nodeCounts: Record<string, number> = {};
        const cardCounts: Record<string, number> = {};
        const problemCounts: Record<string, number> = {};
        
        // 详细的贡献数据，按日期和域分组
        const contributionDetails: Record<string, Array<{
            domainId: string;
            domainName: string;
            nodes: number;
            cards: number;
            problems: number;
        }>> = {};

        for (const did of domainIds) {
            const ddoc = await domain.get(did);
            const domainName = ddoc?.name || did;
            // 获取独立的 nodes（document.TYPE_NODE）
            const independentNodes = await document.getMulti(did, document.TYPE_NODE, { owner: uid })
                .project({ createdAt: 1 })
                .toArray();
            for (const nodeDoc of independentNodes) {
                if (nodeDoc.createdAt) {
                    const date = moment(nodeDoc.createdAt).format('YYYY-MM-DD');
                    nodeCounts[date] = (nodeCounts[date] || 0) + 1;
                    
                    // 记录详细信息
                    if (!contributionDetails[date]) {
                        contributionDetails[date] = [];
                    }
                    let detail = contributionDetails[date].find(d => d.domainId === did);
                    if (!detail) {
                        detail = { domainId: did, domainName, nodes: 0, cards: 0, problems: 0 };
                        contributionDetails[date].push(detail);
                    }
                    detail.nodes += 1;
                }
            }

            // 获取思维导图中的节点（MindMapDoc 中的 nodes）
            // 注意：思维导图中的节点存储在 MindMapDoc 的 nodes 数组中，不是独立的文档
            const mindMaps = await document.getMulti(did, document.TYPE_MINDMAP, { owner: uid })
                .project({ nodes: 1, branchData: 1, updateAt: 1, createdAt: 1 })
                .toArray();
            for (const mindMapDoc of mindMaps) {
                let totalNodesInMindMap = 0;
                const nodeIds = new Set<string>(); // 用于去重（不同分支可能有相同节点）
                
                // 统计主分支的节点
                if (mindMapDoc.nodes && Array.isArray(mindMapDoc.nodes)) {
                    for (const node of mindMapDoc.nodes) {
                        if (node && node.id) {
                            nodeIds.add(node.id);
                        }
                    }
                }
                
                // 统计分支数据中的节点
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
                
                // 使用 updateAt 作为节点更新的日期（因为节点没有独立的时间戳）
                // 如果 MindMap 被更新，说明节点可能被添加或修改
                if (totalNodesInMindMap > 0) {
                    const date = mindMapDoc.updateAt 
                        ? moment(mindMapDoc.updateAt).format('YYYY-MM-DD')
                        : (mindMapDoc.createdAt ? moment(mindMapDoc.createdAt).format('YYYY-MM-DD') : null);
                    if (date) {
                        // 只记录节点数量的变化，而不是累加所有节点
                        // 这里我们记录 MindMap 更新时的节点总数
                        nodeCounts[date] = (nodeCounts[date] || 0) + totalNodesInMindMap;
                        
                        // 记录详细信息
                        if (!contributionDetails[date]) {
                            contributionDetails[date] = [];
                        }
                        let detail = contributionDetails[date].find(d => d.domainId === did);
                        if (!detail) {
                            detail = { domainId: did, domainName, nodes: 0, cards: 0, problems: 0 };
                            contributionDetails[date].push(detail);
                        }
                        detail.nodes += totalNodesInMindMap;
                    }
                }
            }

            // 获取 cards
            const cards = await document.getMulti(did, document.TYPE_CARD, { owner: uid })
                .project({ createdAt: 1, problems: 1 })
                .toArray();
            for (const cardDoc of cards) {
                if (cardDoc.createdAt) {
                    const date = moment(cardDoc.createdAt).format('YYYY-MM-DD');
                    cardCounts[date] = (cardCounts[date] || 0) + 1;
                    
                    // 记录详细信息
                    if (!contributionDetails[date]) {
                        contributionDetails[date] = [];
                    }
                    let detail = contributionDetails[date].find(d => d.domainId === did);
                    if (!detail) {
                        detail = { domainId: did, domainName, nodes: 0, cards: 0, problems: 0 };
                        contributionDetails[date].push(detail);
                    }
                    detail.cards += 1;
                    
                    // 统计 problems
                    if (cardDoc.problems && Array.isArray(cardDoc.problems)) {
                        const problemCount = cardDoc.problems.length;
                        problemCounts[date] = (problemCounts[date] || 0) + problemCount;
                        detail.problems += problemCount;
                    }
                }
            }
        }

        // 合并贡献数据
        const allDates = new Set([...Object.keys(nodeCounts), ...Object.keys(cardCounts), ...Object.keys(problemCounts)]);
        for (const date of allDates) {
            if (nodeCounts[date]) {
                contributions.push({ date, type: 'node', count: nodeCounts[date] });
            }
            if (cardCounts[date]) {
                contributions.push({ date, type: 'card', count: cardCounts[date] });
            }
            if (problemCounts[date]) {
                contributions.push({ date, type: 'problem', count: problemCounts[date] });
            }
        }

        // 统计总数（需要重新计算，因为 nodeCounts 可能包含重复）
        // 重新统计所有 MindMap 中的节点总数
        let totalNodes = 0;
        for (const did of domainIds) {
            // 独立的 nodes
            const independentNodes = await document.getMulti(did, document.TYPE_NODE, { owner: uid })
                .project({ _id: 1 })
                .toArray();
            totalNodes += independentNodes.length;
            
            // 思维导图中的节点
            const mindMaps = await document.getMulti(did, document.TYPE_MINDMAP, { owner: uid })
                .project({ nodes: 1, branchData: 1 })
                .toArray();
            for (const mindMapDoc of mindMaps) {
                const nodeIds = new Set<string>();
                
                // 统计主分支的节点
                if (mindMapDoc.nodes && Array.isArray(mindMapDoc.nodes)) {
                    for (const node of mindMapDoc.nodes) {
                        if (node && node.id) {
                            nodeIds.add(node.id);
                        }
                    }
                }
                
                // 统计分支数据中的节点
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
                
                totalNodes += nodeIds.size;
            }
        }
        
        const totalCards = Object.values(cardCounts).reduce((sum, count) => sum + count, 0);
        const totalProblems = Object.values(problemCounts).reduce((sum, count) => sum + count, 0);

        this.response.template = 'user_detail.html';
        this.response.body = {
            isSelfProfile, udoc, sdoc,
            joinedDomains,
            contributions,
            contributionDetails,
            stats: {
                totalNodes,
                totalCards,
                totalProblems,
            },
        };

        // 设置 UiContext 数据供前端使用
        this.UiContext.joinedDomains = joinedDomains;
        this.UiContext.contributions = contributions;
        this.UiContext.contributionDetails = contributionDetails;
        this.UiContext.stats = {
            totalNodes,
            totalCards,
            totalProblems,
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

        // 验证日期格式
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new ValidationError('Invalid date format');
        }

        // 验证目标域是否存在
        const targetDomain = await domain.get(targetDomainId);
        if (!targetDomain) {
            throw new NotFoundError(`Domain ${targetDomainId} not found`);
        }

        // 验证用户是否加入了该域
        const dudict = await domain.getDictUserByDomainId(uid);
        if (!dudict[targetDomainId]?.join) {
            throw new ForbiddenError('User has not joined this domain');
        }

        // 获取该日期在该域的具体贡献
        const contributions: {
            nodes: Array<{ id: string; name: string; createdAt: Date; type: 'independent' | 'mindmap' }>;
            cards: Array<{ docId: string; title: string; nodeId: string; createdAt: Date; problems?: number }>;
            problems: Array<{ cardId: string; cardTitle: string; pid: string; stem: string; createdAt: Date }>;
        } = {
            nodes: [],
            cards: [],
            problems: [],
        };

        // 获取独立的节点
        const independentNodes = await document.getMulti(targetDomainId, document.TYPE_NODE, { owner: uid })
            .project({ nid: 1, name: 1, createdAt: 1 })
            .toArray();
        for (const nodeDoc of independentNodes) {
            if (nodeDoc.createdAt) {
                const nodeDate = moment(nodeDoc.createdAt).format('YYYY-MM-DD');
                if (nodeDate === date) {
                    contributions.nodes.push({
                        id: nodeDoc.nid?.toString() || nodeDoc._id.toString(),
                        name: nodeDoc.name || '未命名节点',
                        createdAt: nodeDoc.createdAt,
                        type: 'independent',
                    });
                }
            }
        }

        // 获取思维导图中的节点（使用 updateAt 作为日期）
        const mindMaps = await document.getMulti(targetDomainId, document.TYPE_MINDMAP, { owner: uid })
            .project({ docId: 1, title: 1, nodes: 1, branchData: 1, updateAt: 1, createdAt: 1 })
            .toArray();
        for (const mindMapDoc of mindMaps) {
            const mapDate = mindMapDoc.updateAt 
                ? moment(mindMapDoc.updateAt).format('YYYY-MM-DD')
                : (mindMapDoc.createdAt ? moment(mindMapDoc.createdAt).format('YYYY-MM-DD') : null);
            
            if (mapDate === date) {
                // 收集所有节点
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
                
                // 添加节点到贡献列表
                for (const nodeId of nodeIds) {
                    const node = nodeMap.get(nodeId);
                    contributions.nodes.push({
                        id: nodeId,
                        name: node?.text || node?.name || '未命名节点',
                        createdAt: mindMapDoc.updateAt || mindMapDoc.createdAt,
                        type: 'mindmap',
                    });
                }
            }
        }

        // 获取卡片
        const cards = await document.getMulti(targetDomainId, document.TYPE_CARD, { owner: uid })
            .project({ docId: 1, title: 1, nodeId: 1, createdAt: 1, problems: 1 })
            .toArray();
        for (const cardDoc of cards) {
            if (cardDoc.createdAt) {
                const cardDate = moment(cardDoc.createdAt).format('YYYY-MM-DD');
                if (cardDate === date) {
                    contributions.cards.push({
                        docId: cardDoc.docId.toString(),
                        title: cardDoc.title || '未命名卡片',
                        nodeId: cardDoc.nodeId || '',
                        createdAt: cardDoc.createdAt,
                        problems: cardDoc.problems?.length || 0,
                    });

                    // 添加题目
                    if (cardDoc.problems && Array.isArray(cardDoc.problems)) {
                        for (const problem of cardDoc.problems) {
                            contributions.problems.push({
                                cardId: cardDoc.docId.toString(),
                                cardTitle: cardDoc.title || '未命名卡片',
                                pid: problem.pid || '',
                                stem: problem.stem || '无题干',
                                createdAt: cardDoc.createdAt,
                            });
                        }
                    }
                }
            }
        }

        // 获取思维导图信息（用于显示节点链接）
        const mindMap = await mindmap.MindMapModel.getByDomain(targetDomainId);

        this.response.template = 'user_contribution_detail.html';
        this.response.body = {
            udoc,
            targetDomain,
            date,
            contributions,
            mindMapDocId: mindMap?.docId,
        };

        this.UiContext.extraTitleContent = `${udoc.uname} - ${date} 在 ${targetDomain.name} 的贡献`;
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