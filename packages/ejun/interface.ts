import type { Binary, FindCursor, ObjectId } from 'mongodb';
import type { Context } from './context';
import type { DocStatusType } from './model/document';
import type { Handler } from './service/server';

type document = typeof import('./model/document');

export interface System {
    _id: string,
    value: any,
}
export interface Script {
    run: (args: any, report: Function) => any,
    description: string,
    validate: any,
}

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

export interface VUdoc {
    _id: number;
    mail: string;
    mailLower: string;
    uname: string;
    unameLower: string;
    salt: '';
    hash: '';
    hashType: 'Ejunz';
    priv: 0;
    regat: Date;
    loginat: Date;
    ip: ['127.0.0.1'];
    loginip: '127.0.0.1';
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
        'vuser': VUdoc;
        'check': System;
        'status': any;
        'system': System;
    }
}

export interface Model {
    user: typeof import('./model/user').default
}

export interface ModuleInterfaces {
    oauth: {
        text: string;
        icon?: string;
        get: (this: Handler) => Promise<void>;
        callback: (this: Handler, args: Record<string, any>) => Promise<OAuthUserResponse>;
        lockUsername?: boolean;
    };
    hash: (password: string, salt: string, user: User) => boolean | string | Promise<string>;
}
export interface EjunzService {
    /** @deprecated */
    bus: Context,
    db: typeof import('./service/db').default,
    server: typeof import('./service/server'),
    storage: typeof import('./service/storage').default,
}



export interface EjunzGlobal {
    version: Record<string, string>;
    model: Model;
    // script: Record<string, Script>;
    service: EjunzService;
    // lib: Lib;
    module: { [K in keyof ModuleInterfaces]: Record<string, ModuleInterfaces[K]> };
    // ui: UI;
    error: typeof import('./error');
    Logger: typeof import('./logger').Logger;
    logger: typeof import('./logger').logger;
    locales: Record<string, Record<string, string> & Record<symbol, Record<string, string>>>;
}

declare global {
    namespace NodeJS {
        interface Global {
            Ejunz: EjunzGlobal,
            addons: string[],
        }
    }
    /** @deprecated */
    var bus: Context; 
    var app: Context; 
    var Ejunz: EjunzGlobal; 
    var addons: string[]; 
}
