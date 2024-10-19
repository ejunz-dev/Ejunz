import type { AuthenticationExtensionsAuthenticatorOutputs } from '@simplewebauthn/server/esm/helpers/decodeAuthenticatorExtensions';
import type { AttestationFormat } from '@simplewebauthn/server/helpers';
import { CredentialDeviceType } from '@simplewebauthn/types';
import type fs from 'fs';
import type { Dictionary, NumericDictionary } from 'lodash';
import type { Binary, FindCursor, ObjectId } from 'mongodb';
import type { Context } from './context';


export interface Udoc extends Record<string, any> {
    _id: number;
    mail: string;
    mailLower: string;
    uname: string;
    unameLower: string;
    salt: string;
    hash: string;
    hashType: string;
    priv: number;
    regat: Date;
    loginat: Date;
    ip: string[];
    loginip: string;
}



export type User = import('./model/user').User;
export type Udict = Record<number, User>;

export interface BaseUser {
    _id: number;
    uname: string;
    mail: string;
    avatar: string;
    school?: string;
    displayName?: string;
    studentId?: string;
}
export type BaseUserDict = Record<number, BaseUser>;

declare module './service/db' {
    interface Collections {
        'user': Udoc;
        
    }
}

export interface Model {
    user: typeof import('./model/user').default,
}


export interface EjunzGlobal {
    version: Record<string, string>;
    model: Model;
    error: typeof import('./error');
    Logger: typeof import('./logger').Logger;
    logger: typeof import('./logger').logger;
}

declare global {
    namespace NodeJS {
        interface Global {
            Hydro: EjunzGlobal,
            addons: string[],
        }
    }
    /** @deprecated */
    var bus: Context; 
    var app: Context; 
    var Hydro: EjunzGlobal; 
    var addons: string[]; 
}
