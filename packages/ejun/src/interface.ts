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
        mcpToolIds?: ObjectId[]; // 分配的MCP工具ID列表
    }
}
export type { AgentDoc } from './model/agent';

// Repo/Base/Doc/Block documents
export interface BSDoc {
    docType: document['TYPE_BS']; // Base 
    docId: ObjectId;
    domainId: string;
    rpids: number[]; // 存储所有 Repo ID
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}

export interface RPDoc {
    docType: document['TYPE_RP'];  // 标识它是一个 Repo
    docId: ObjectId;
    domainId: string;
    rpid: number;
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
    currentBranch?: string; // 当前编辑分支
    branches?: string[];    // 已存在的本地分支列表
    githubRepo?: string;    // GitHub 仓库地址，如 git@github.com:user/repo.git
    mode?: 'file' | 'manuscript'; // 显示模式：文件模式或文稿模式
    config?: Record<string, any>; // Repo 配置
}

export interface DCDoc {
    docType: document['TYPE_DC'];
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number;  // Doc ID，从1开始
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    parentId?: number|null;
    path: string;
    doc: boolean;
    childrenCount?: number;
    createdAt?: Date;
    branch?: string; // 所属分支，默认为 main
    order?: number;
}

export interface BKDoc {
    docType: document['TYPE_BK'];
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number;  // 关联的 doc ID
    bid: number;  // Block ID，从1开始
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    createdAt?: Date;
    branch?: string; // 所属分支，默认为 main
    order?: number;
}

// Node document
declare module './model/node' {
    interface NodeDoc {
        _id: ObjectId; // document 系统自动添加
        docType: document['TYPE_NODE'];
        docId: ObjectId; // 由 mongo 自动生成
        domainId: string;
        nodeId: number; // 节点 ID，从 1 开始（业务 ID）
        name: string;
        description?: string;
        wsEndpoint?: string; // WebSocket 接入点路径（可选，生成接入点时设置）
        mqttClientId?: string; // MQTT 客户端 ID
        status: 'active' | 'inactive' | 'disconnected';
        host?: string; // Node 主机地址
        port?: number; // Node 端口
        createdAt: Date;
        updatedAt: Date;
        owner: number; // 用户 ID
        content?: string; // document 系统要求
    }
}
export type { NodeDoc } from './model/node';

// MCP Server document
declare module './model/mcp' {
    interface McpServerDoc {
        _id: ObjectId; // document 系统自动添加
        docType: document['TYPE_MCP_SERVER'];
        docId: ObjectId; // 由 mongo 自动生成
        domainId: string;
        serverId: number; // MCP 服务器 ID，从 1 开始（业务 ID）
        name: string;
        description?: string;
        wsEndpoint: string; // WebSocket 接入点路径
        wsToken?: string; // WebSocket 连接令牌（用于验证）
        status: 'connected' | 'disconnected' | 'error'; // 服务器连接状态
        lastConnectedAt?: Date; // 最后连接时间
        lastDisconnectedAt?: Date; // 最后断开时间
        errorMessage?: string; // 错误信息
        toolsCount?: number; // 工具数量
        createdAt: Date;
        updatedAt: Date;
        owner: number; // 用户 ID
        content?: string; // document 系统要求
    }

    interface McpToolDoc {
        _id: ObjectId; // document 系统自动添加
        docType: document['TYPE_MCP_TOOL'];
        docId: ObjectId; // 由 mongo 自动生成
        domainId: string;
        serverId: number; // 所属 MCP 服务器 ID
        serverDocId: ObjectId; // 所属 MCP 服务器的 docId
        toolId: number; // 工具 ID，从 1 开始（业务 ID）
        name: string; // 工具名称
        description: string; // 工具描述
        inputSchema: {
            type: string;
            properties?: Record<string, any>;
        }; // 工具输入模式
        createdAt: Date;
        updatedAt: Date;
        owner: number; // 用户 ID
        content?: string; // document 系统要求
    }
}

// Client document
declare module './model/client' {
    interface ClientDoc {
        _id: ObjectId;
        docType: document['TYPE_CLIENT'];
        docId: ObjectId;
        domainId: string;
        clientId: number;
        name: string;
        description?: string;
        wsEndpoint: string;
        wsToken?: string;
        status: 'connected' | 'disconnected' | 'error';
        lastConnectedAt?: Date;
        lastDisconnectedAt?: Date;
        errorMessage?: string;
        settings: {
            asr?: {
                provider: string;
                apiKey: string;
                model: string;
                enableServerVad?: boolean;
                baseUrl?: string;
                language?: string;
            };
            tts?: {
                provider: string;
                apiKey: string;
                endpoint?: string;
                model: string;
                voice?: string;
                languageType?: string;
            };
            agent?: {
                agentId?: string;
                agentDocId?: ObjectId;
            };
        };
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }
}
export type { McpServerDoc, McpToolDoc } from './model/mcp';
export type { ClientDoc } from './model/client';

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
        'node': import('./model/node').NodeDoc;
        'node.device': import('./model/node').NodeDeviceDoc;
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
    bs: typeof import('./model/repo').BaseModel,
    rp: typeof import('./model/repo').RepoModel,
    dc: typeof import('./model/repo').DocModel,
    bk: typeof import('./model/repo').BlockModel,
    node: typeof import('./model/node').default,
    nodeDevice: typeof import('./model/node').NodeDeviceModel,
    mcpServer: typeof import('./model/mcp').default,
    mcpTool: typeof import('./model/mcp').McpToolModel,
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