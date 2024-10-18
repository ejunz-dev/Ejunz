import { LRUCache } from 'lru-cache';
import { Collection } from 'mongodb';
import { LoginError, UserAlreadyExistError, UserNotFoundError } from '../error';
import pwhash from '../lib/hash.ejunz';
import db from '../service/db';


export const coll: Collection<any> = db.collection('user');
const cache = new LRUCache<string, any>({ max: 10000, ttl: 300 * 1000 });

export class User {
    _id: number;
    uname: string;
    mail: string;
    salt: string;
    hash: string;
    regat: Date;
    loginat: Date;

    constructor(udoc: any) {
        this._id = udoc._id;
        this.uname = udoc.uname;
        this.mail = udoc.mail;
        this.salt = udoc.salt;
        this.hash = udoc.hash;
        this.regat = udoc.regat;
        this.loginat = udoc.loginat;
    }

    async checkPassword(password: string) {
        const result = await pwhash(password, this.salt);
        if (result !== this.hash) {
            throw new LoginError(this.uname);
        }
    }
}

async function initAndCache(udoc: any) {
    const user = new User(udoc);
    cache.set(`id/${udoc._id}`, user);
    cache.set(`name/${udoc.uname.toLowerCase()}`, user);
    return user;
}

class UserModel {
    static async getById(_id: number): Promise<User> {
        if (cache.has(`id/${_id}`)) return cache.get(`id/${_id}`) as User;
        const udoc = await coll.findOne({ _id });
        if (!udoc) throw new UserNotFoundError(_id.toString());
        return initAndCache(udoc);
    }

    static async getByUname(uname: string): Promise<User> {
        const unameLower = uname.toLowerCase();
        if (cache.has(`name/${unameLower}`)) return cache.get(`name/${unameLower}`) as User;
        const udoc = await coll.findOne({ unameLower });
        if (!udoc) throw new UserNotFoundError(uname);
        return initAndCache(udoc);
    }

    static async create(uname: string, password: string, regip: string) {
        const salt = String.random();
        const hash = await pwhash(password, salt);
        const regat = new Date();
        const uid = await coll.countDocuments() + 1;

        try {
            await coll.insertOne({
                _id: uid,
                uname,
                unameLower: uname.trim().toLowerCase(),
                mail: `${uid}@example.com`,
                mailLower: `${uid}@example.com`,
                salt,
                hash,
                regat,
                loginat: regat,
                ip: [regip],
            });
            return uid;
        } catch (e) {
            throw new UserAlreadyExistError(uname);
        }
    }
}

export default UserModel;
