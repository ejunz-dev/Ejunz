import type { AttestationFormat, CredentialDeviceType, } from '@simplewebauthn/server';
import type { AuthenticationExtensionsAuthenticatorOutputs } from '@simplewebauthn/server/esm/helpers/decodeAuthenticatorExtensions';
import type fs from 'fs';
import type { Dictionary, NumericDictionary } from 'lodash';
import type { Binary, FindCursor, ObjectId } from 'mongodb';
import type { Context } from './context';
import type { DocStatusType } from './model/document';
import type { AgentDoc } from './model/agent';
import type { Handler } from './service/server';

export * from '@ejunz/common/types';

type document = typeof import('./model/document');

export interface System {
    _id: string,
    value: any,
}

export interface SystemKeys {
    'smtp.user': string;
    'smtp.from': string;
    'smtp.pass': string;
    'smtp.host': string;
    'smtp.port': number;
    'smtp.secure': boolean;
    installid: string;
    'server.name': string;
    'server.url': string;
    'server.xff': string;
    'server.xhost': string;
    'server.host': string;
    'server.port': number;
    'server.language': string;
    'limit.problem_files_max': number;
    'problem.categories': string;
    'session.keys': string[];
    'session.saved_expire_seconds': number;
    'session.unsaved_expire_seconds': number;
    'user.quota': number;
}

export interface Setting {
    family: string;
    key: string;
    range: [string, string][] | Record<string, string>;
    value: any;
    type: string;
    subType?: string;
    name: string;
    desc: string;
    flag: number;
    validation?: (val: any) => boolean;
}

export interface Authenticator {
    name: string;
    regat: number;

    fmt: AttestationFormat;
    counter: number;
    aaguid: string;
    credentialID: Binary;
    credentialPublicKey: Binary;
    credentialType: 'public-key';
    attestationObject: Binary;
    userVerified: boolean;
    credentialDeviceType: CredentialDeviceType;
    credentialBackedUp: boolean;
    authenticatorExtensionResults?: ParsedAuthenticatorData['extensionsData'];
    authenticatorAttachment: 'platform' | 'cross-platform';
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
    hashType: 'ejunz';
    priv: 0;
    regat: Date;
    loginat: Date;
    ip: ['127.0.0.1'];
    loginip: '127.0.0.1';
}

export interface GDoc {
    _id: ObjectId;
    domainId: string;
    name: string;
    uids: number[];
}

export interface UserPreferenceDoc {
    _id: ObjectId;
    filename: string;
    uid: number;
    content: string;
}

export type ownerInfo = { owner: number, maintainer?: number[] };

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

export interface FileInfo {
    /** storage path */
    _id: string,
    /** filename */
    name: string,
    /** file size (in bytes) */
    size: number,
    etag: string,
    lastModified: Date,
}

export enum SubtaskType {
    min = 'min',
    max = 'max',
    sum = 'sum',
}

export interface SubtaskConfig {
    time?: string;
    memory?: string;
    score?: number;
    if?: number[];
    id?: number;
    type?: SubtaskType;
    cases?: TestCaseConfig[];
}


export interface PlainContentNode {
    type: 'Plain',
    subType: 'html' | 'markdown',
    text: string,
}
export interface TextContentNode {
    type: 'Text',
    subType: 'html' | 'markdown',
    sectionTitle: string,
    text: string,
}
export interface SampleContentNode {
    type: 'Sample',
    text: string,
    sectionTitle: string,
    payload: [string, string],
}
// TODO drop contentNode support
export type ContentNode = PlainContentNode | TextContentNode | SampleContentNode;
export type Content = string | ContentNode[] | Record<string, ContentNode[]>;

export interface Document {
    _id: ObjectId;
    docId: any;
    docType: number;
    domainId: string;
    owner: number;
    maintainer?: number[];
}



declare module './model/agent'{
    interface AgentDoc {
        docType: document['TYPE_AGENT'];
        docId: number;
        aid: string;
        title: string;
        content: string;
        tag?: string[];
        ip: string;
        updateAt: Date;
        nReply: number;
        views: number;
        reply: any[];
        domainId: string;
        owner: number;
        apiKey?: string;
        memory?: string;
    }
}
export type { AgentDoc } from './model/agent';

// Tree/Forest/Branch documents
export interface FRDoc {
    docType: 7; // Forest 
    docId: ObjectId;
    domainId: string;
    trids: number[]; // 存储所有 Tree ID
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}

export interface TRDoc {
    docType: 6;  // 标识它是一个 Tree
    docId: ObjectId;
    domainId: string;
    trid: number;
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}

export interface BRDoc {
    docType: 1;
    docId: ObjectId;
    domainId: string;
    trid: number;
    bid: number;
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    lids: Array<number>;
    rids: Array<number>;
    parentId?: number|null;
    path: string;
    branch: boolean;
    childrenCount?: number;
    createdAt?: Date;
}

export interface DomainDoc extends Record<string, any> {
    _id: string,
    owner: number,
    roles: Dictionary<string>,
    avatar: string,
    bulletin: string,
    _join?: any,
    host?: string[],
    _files: FileInfo[];
}

// Message
export interface MessageDoc {
    _id: ObjectId,
    from: number,
    to: number,
    content: string,
    flag: number,
}

// Blacklist
export interface BlacklistDoc {
    /**
     * @example ip:1.1.1.1
     * @example mail:foo.com
     */
    _id: string;
    expireAt: Date;
}

// Discussion
export type { DiscussionDoc } from './model/discussion';
declare module './model/discussion' {
    interface DiscussionDoc {
        docType: document['TYPE_DISCUSSION'];
        docId: ObjectId;
        parentType: number;
        parentId: ObjectId | number | string;
        title: string;
        content: string;
        ip: string;
        pin: boolean;
        highlight: boolean;
        updateAt: Date;
        nReply: number;
        views: number;
        edited?: boolean;
        editor?: number;
        react: Record<string, number>;
        sort: number;
        lastRCount: number;
        lock?: boolean;
        hidden?: boolean;
    }
}

export interface DiscussionReplyDoc extends Document {
    // docType: document['TYPE_DISCUSSION_REPLY'];
    docId: ObjectId;
    // parentType: document['TYPE_DISCUSSION'];
    parentId: ObjectId;
    ip: string;
    content: string;
    reply: DiscussionTailReplyDoc[];
    edited?: boolean;
    editor?: number;
    react: Record<string, number>;
}

export interface DiscussionTailReplyDoc {
    _id: ObjectId;
    owner: number;
    content: string;
    ip: string;
    edited?: boolean;
    editor?: number;
}

export interface ContestClarificationDoc extends Document {
    // docType: document['TYPE_CONTEST_CLARIFICATION'];
    docId: ObjectId;
    // parentType: document['TYPE_CONTEST'];
    parentId: ObjectId;
    // -1: technique
    subject: number;
    ip: string;
    content: string;
    reply: DiscussionTailReplyDoc[];
}

export interface TokenDoc {
    _id: string,
    tokenType: number,
    createAt: Date,
    updateAt: Date,
    expireAt: Date,
    [key: string]: any,
}

export interface OplogDoc extends Record<string, any> {
    _id: ObjectId,
    type: string,
}

export interface Script {
    run: (args: any, report: Function) => any,
    description: string,
    validate: any,
}


export interface Task {
    _id: ObjectId;
    type: string;
    subType?: string;
    priority: number;
    [key: string]: any;
}

export interface Schedule {
    _id: ObjectId;
    type: string;
    subType?: string;
    executeAfter: Date;
    [key: string]: any;
}

export interface FileNode {
    /** File Path In S3 */
    _id: string;
    /** Actual File Path */
    path: string;
    lastUsage?: Date;
    lastModified?: Date;
    etag?: string;
    /** Size: in bytes */
    size?: number;
    /** AutoDelete */
    autoDelete?: Date;
    /** fileId if linked to an existing file */
    link?: string;
    owner?: number;
    operator?: number[];
    meta?: Record<string, string | number>;
}

export interface EventDoc {
    ack: string[];
    event: number | string;
    payload: string;
    expire: Date;
}

export interface OpCountDoc {
    _id: ObjectId;
    op: string;
    ident: string;
    expireAt: Date;
    opcount: number;
}

export type { OauthMap, OAuthProvider, OAuthUserResponse } from './model/oauth';

export interface DiscussionHistoryDoc {
    title?: string;
    content: string;
    domainId: string;
    docId: ObjectId;
    /** Create time */
    time: Date;
    uid: number;
    ip: string;
}

export interface LockDoc {
    _id: ObjectId;
    key: string;
    lockAt: Date;
    daemonId: string;
}


declare module './service/db' {
    interface Collections {
        'blacklist': BlacklistDoc;
        'domain': DomainDoc;
        'domain.user': any;
        'document': any;
        'document.status': StatusDocBase & {
            [K in keyof DocStatusType]: { docType: K } & DocStatusType[K];
        }[keyof DocStatusType];
        'discussion.history': DiscussionHistoryDoc;
        'user': Udoc;
        'user.preference': UserPreferenceDoc;
        'vuser': VUdoc;
        'user.group': GDoc;
        'check': System;
        'message': MessageDoc;
        'token': TokenDoc;
        'status': any;
        'oauth': OauthMap;
        'system': System;
        'task': Task;
        'storage': FileNode;
        'oplog': OplogDoc;
        'event': EventDoc;
        'opcount': OpCountDoc;
        'schedule': Schedule;
    }
}

export interface Model {
    blacklist: typeof import('./model/blacklist').default,
    builtin: typeof import('./model/builtin'),
    discussion: typeof import('./model/discussion'),
    document: Omit<typeof import('./model/document'), 'apply'>,
    domain: typeof import('./model/domain').default,
    agent: typeof import('./model/agent').default,
    message: typeof import('./model/message').default,
    opcount: typeof import('./model/opcount'),
    setting: typeof import('./model/setting'),
    system: typeof import('./model/system').default,
    task: typeof import('./model/task').default,
    schedule: typeof import('./model/schedule').default;
    oplog: typeof import('./model/oplog'),
    token: typeof import('./model/token').default,
    user: typeof import('./model/user').default,
    oauth: typeof import('./model/oauth').default,
    storage: typeof import('./model/storage').default,
    tree: {
        ForestModel: typeof import('./model/tree').ForestModel,
        TreeModel: typeof import('./model/tree').TreeModel,
        BranchModel: typeof import('./model/tree').BranchModel,
        TYPE_FR: typeof import('./model/tree').TYPE_FR,
        TYPE_TR: typeof import('./model/tree').TYPE_TR,
        TYPE_BR: typeof import('./model/tree').TYPE_BR,
        getProblemsByDocsId: typeof import('./model/tree').getProblemsByDocsId,
        getRelated: typeof import('./model/tree').getRelated,
    },
}

export interface GeoIP {
    provider: string,
    lookup: (ip: string, locale?: string) => any,
}

export interface RepoSearchResponse {
    hits: string[];
    total: number;
    countRelation: 'eq' | 'gte';
}
export interface RepoSearchOptions {
    limit?: number;
    skip?: number;
}

export type RepoSearch = (domainId: string, q: string, options?: RepoSearchOptions) => Promise<RepoSearchResponse>;

export interface Lib {
    repoSearch: RepoSearch;
}


export type UIInjectableFields = 
    'ProblemAdd' |'RepoAdd' | 'AgentAdd' | 'Notification' | 'Nav' | 'UserDropdown' | 'DomainManage' | 'ControlPanel' | 'ProfileHeaderContact' | 'Home_Domain' | 'NavDropdown' | 'NavMainDropdown'
export interface UI {
    nodes: Record<UIInjectableFields, any[]>,
    getNodes: typeof import('./lib/ui').getNodes,
    inject: typeof import('./lib/ui').inject,
}

export interface ModuleInterfaces {
    hash: (password: string, salt: string, user: User) => boolean | string | Promise<string>;
}

export interface EjunzGlobal {
    version: Record<string, string>;
    model: Model;
    script: Record<string, Script>;
    module: { [K in keyof ModuleInterfaces]: Record<string, ModuleInterfaces[K]> };
    ui: UI;
    error: typeof import('./error');
    Logger: typeof import('./logger').Logger;
    logger: typeof import('./logger').logger;
    locales: Record<string, Record<string, string> & Record<symbol, Record<string, string>>>;
}


declare global {
    namespace NodeJS {
        interface Global {
            Ejunz: EjunzGlobal;
            addons: string[];
        }
    }
    /** @deprecated */
    var bus: Context; // eslint-disable-line
    var app: Context; // eslint-disable-line
    var Ejunz: EjunzGlobal; // eslint-disable-line
    var addons: Record<string, string>; // eslint-disable-line
}