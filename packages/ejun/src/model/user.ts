import { escapeRegExp, pick, uniq } from 'lodash';
import { LRUCache } from 'lru-cache';
import { Collection, Filter, ObjectId } from 'mongodb';
import { serializer } from '@ejunz/framework';
import { LoginError, UserAlreadyExistError, UserNotFoundError } from '../error';
import {
    Authenticator, BaseUserDict, FileInfo, GDoc,
    ownerInfo, Udict, Udoc, VUdoc,
} from '../interface';
import pwhash from '../lib/hash.ejunz';
import * as bus from '../service/bus';
import db from '../service/db';
import { Value } from '../typeutils';
import { ArgMethod, buildProjection } from '../utils';

export const coll: Collection<Udoc> = db.collection('user');

const cache = new LRUCache<string, User>({ max: 10000, ttl: 300 * 1000 });


export class User {
    _id: number;
    _isPrivate = false;

    _udoc: Udoc;
    _dudoc: any;
    _salt: string;
    _hash: string;
    _regip: string;
    _loginip: string;
    _tfa: string;
    _authenticators: Authenticator[];

    mail: string;
    uname: string;
    hashType: string;
    priv: number;
    regat: Date;
    loginat: Date;
    perm: bigint;
    role: string;
    scope: bigint;
    _files: FileInfo[];
    tfa: boolean;
    authn: boolean;
    group?: string[];
    [key: string]: any;

    constructor(udoc: Udoc,) {
        this._id = udoc._id;

        this._udoc = udoc;
        this._salt = udoc.salt;
        this._hash = udoc.hash;
        this._regip = udoc.ip?.[0] || '';
        this._loginip = udoc.loginip;
        this._files = udoc._files || [];
        this._tfa = udoc.tfa;
        this._authenticators = udoc.authenticators || [];

        this.mail = udoc.mail;
        this.uname = udoc.uname;
        this.hashType = udoc.hashType || 'ejunz';
        this.priv = udoc.priv;
        this.regat = udoc.regat;
        this.loginat = udoc.loginat;
        this.tfa = !!udoc.tfa;
        this.authn = (udoc.authenticators || []).length > 0;
        }
    
    async init() {
        await bus.parallel('user/get', this);
        return this;
    }

    async checkPassword(password: string) {
        const h = global.Ejunz.module.hash[this.hashType];
        if (!h) throw new Error('Unknown hash method');
        const result = await h(password, this._salt, this);
        if (result !== true && result !== this._hash) {
            throw new LoginError(this.uname);
        }
        if (this.hashType !== 'ejunz') {
            UserModel.setPassword(this._id, password);
        }
    }

}
declare module '@ejunz/framework' {
    interface UserModel extends User { }
}

export function handleMailLower(mail: string) {
    const [n, d] = mail.trim().toLowerCase().split('@');
    const [name] = n.split('+');
    return `${name.replace(/\./g, '')}@${d === 'googlemail.com' ? 'gmail.com' : d}`;
}

async function initAndCache(udoc: Udoc) {
    const res = new User(udoc);  
    cache.set(`id/${udoc._id}`, res);
    cache.set(`name/${udoc.unameLower}`, res);
    cache.set(`mail/${udoc.mailLower}`, res);
    return res;
}

class UserModel {
    static coll = coll;
    static User = User;
    static cache = cache;
    static defaultUser: Udoc = {
        _id: 0,
        uname: 'Unknown User',
        unameLower: 'unknown user',
        avatar: 'gravatar:unknown@hydro.local',
        mail: 'unknown@hydro.local',
        mailLower: 'unknown@hydro.local',
        salt: '',
        hash: '',
        hashType: 'ejunz',
        priv: 0,
        perm: 0n,
        regat: new Date('2000-01-01'),
        loginat: new Date('2000-01-01'),
        ip: ['127.0.0.1'],
        loginip: '127.0.0.1',
    };

    @ArgMethod
    static async getById(domainId: string, _id: number, scope: bigint | string = PERM.PERM_ALL): Promise<User> {
        if (cache.has(`id/${_id}/${domainId}`)) return cache.get(`id/${_id}/${domainId}`) || null;
        const udoc = await (_id < -999 ? collV : coll).findOne({ _id });
        if (!udoc) return null;
        const [dudoc, groups] = await Promise.all([
            domain.getDomainUser(domainId, udoc),
            UserModel.listGroup(domainId, _id),
        ]);
        dudoc.group = groups.map((i) => i.name);
        if (typeof scope === 'string') scope = BigInt(scope);
        return initAndCache(udoc, dudoc, scope);
    }

    static async getList(domainId: string, uids: number[]): Promise<Udict> {
        const r: Udict = {};
        await Promise.all(uniq(uids).map(async (uid) => {
            r[uid] = (await UserModel.getById(domainId, uid)) || new User(UserModel.defaultUser, {});
        }));
        return r;
    }

    @ArgMethod
    static async getByUname(domainId: string, uname: string): Promise<User | null> {
        const unameLower = uname.trim().toLowerCase();
        if (cache.has(`name/${unameLower}/${domainId}`)) return cache.get(`name/${unameLower}/${domainId}`);
        const udoc = (await coll.findOne({ unameLower })) || await collV.findOne({ unameLower });
        if (!udoc) return null;
        const dudoc = await domain.getDomainUser(domainId, udoc);
        return initAndCache(udoc, dudoc);
    }

    @ArgMethod
    static async getByEmail(domainId: string, mail: string): Promise<User> {
        const mailLower = handleMailLower(mail);
        if (cache.has(`mail/${mailLower}/${domainId}`)) return cache.get(`mail/${mailLower}/${domainId}`);
        const udoc = await coll.findOne({ mailLower });
        if (!udoc) return null;
        const dudoc = await domain.getDomainUser(domainId, udoc);
        return initAndCache(udoc, dudoc);
    }

    @ArgMethod
    static async setById(uid: number, $set?: Partial<Udoc>, $unset?: Value<Partial<Udoc>, ''>, $push?: any) {
        if (uid < -999) return null;
        const op: any = {};
        if ($set && Object.keys($set).length) op.$set = $set;
        if ($unset && Object.keys($unset).length) op.$unset = $unset;
        if ($push && Object.keys($push).length) op.$push = $push;
        if (op.$set?.loginip) op.$addToSet = { ip: op.$set.loginip };
        const keys = new Set(Object.values(op).flatMap((i) => Object.keys(i)));
        if (keys.has('mailLower') || keys.has('unameLower')) {
            const udoc = await coll.findOne({ _id: uid });
            deleteUserCache(udoc);
        }
        const res = await coll.findOneAndUpdate({ _id: uid }, op, { returnDocument: 'after' });
        deleteUserCache(res.value);
        return res;
    }

    @ArgMethod
    static setUname(uid: number, uname: string) {
        return UserModel.setById(uid, { uname, unameLower: uname.trim().toLowerCase() });
    }

    @ArgMethod
    static setEmail(uid: number, mail: string) {
        return UserModel.setById(uid, { mail, mailLower: handleMailLower(mail) });
    }

    @ArgMethod
    static async setPassword(uid: number, password: string): Promise<Udoc> {
        const salt = String.random();
        const res = await coll.findOneAndUpdate(
            { _id: uid },
            { $set: { salt, hash: await pwhash(password, salt), hashType: 'ejunz' } },
            { returnDocument: 'after' },
        );
        deleteUserCache(res.value);
        return res.value;
    }

  

    @ArgMethod
    static async create(
        mail: string, uname: string, password: string,
        uid?: number, regip: string = '127.0.0.1', priv: number = system.get('default.priv'),
    ) {
        let autoAlloc = false;
        if (typeof uid !== 'number') {
            const [udoc] = await coll.find({}).sort({ _id: -1 }).limit(1).toArray();
            uid = Math.max((udoc?._id || 0) + 1, 2);
            autoAlloc = true;
        }
        const salt = String.random();
        while (true) { 
            try {
                
                await coll.insertOne({
                    _id: uid,
                    mail,
                    mailLower: handleMailLower(mail),
                    uname,
                    unameLower: uname.trim().toLowerCase(),
                    hash: await pwhash(password.toString(), salt),
                    salt,
                    hashType: 'hydro',
                    regat: new Date(),
                    ip: [regip],
                    loginat: new Date(),
                    loginip: regip,
                    priv,
                    avatar: `gravatar:${mail}`,
                });
                return uid;
            } catch (e) {
                if (e?.code === 11000) {
                    // Duplicate Key Error
                    if (autoAlloc && JSON.stringify(e.keyPattern) === '{"_id":1}') {
                        uid++;
                        continue;
                    }
                    throw new UserAlreadyExistError(Object.values(e?.keyValue || {}));
                }
                throw e;
            }
        }
    }

   

    static getMulti(params: Filter<Udoc> = {}, projection?: (keyof Udoc)[]) {
        return projection ? coll.find(params).project<Udoc>(buildProjection(projection)) : coll.find(params);
    }

}

bus.on('ready', () => Promise.all([
    db.ensureIndexes(
        coll,
        { key: { unameLower: 1 }, name: 'uname', unique: true },
        { key: { mailLower: 1 }, name: 'mail', unique: true },
    ),
]));
export default UserModel;
global.Ejunz.model.user = UserModel;
