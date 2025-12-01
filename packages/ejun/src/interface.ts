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
        repoIds?: number[]; // 生效的repo ID列表（rpid数组）
    }
}
export type { AgentDoc } from './model/agent';

// Repo/Base/Doc/Block documents
export interface BaseDoc {
    docType: document['TYPE_BASE']; // Base 
    docId: ObjectId;
    domainId: string;
    rpids: number[]; // 存储所有 Repo ID
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}

export interface RepoDoc {
    docType: document['TYPE_REPO'];  // 标识它是一个 Repo
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
    mcpServerId?: number; // 关联的MCP服务器ID（内部调用，已废弃）
    edgeId?: number; // 关联的Edge ID（当MCP激活时）
}

export interface DocDoc {
    docType: document['TYPE_DOC'];
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

export interface BlockDoc {
    docType: document['TYPE_BLOCK'];
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

// MindMap document
export interface MindMapNode {
    id: string; // 节点唯一标识
    text: string; // 节点文本内容
    x?: number; // X坐标（可选，用于布局）
    y?: number; // Y坐标（可选，用于布局）
    width?: number; // 节点宽度
    height?: number; // 节点高度
    color?: string; // 节点颜色
    backgroundColor?: string; // 节点背景色
    fontSize?: number; // 字体大小
    shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond'; // 节点形状
    parentId?: string; // 父节点ID（用于树形结构）
    children?: string[]; // 子节点ID列表
    expanded?: boolean; // 是否展开（用于折叠/展开功能）
    level?: number; // 节点层级（从根节点开始，0为根节点）
    style?: Record<string, any>; // 自定义样式
    data?: Record<string, any>; // 自定义数据
}

export interface MindMapEdge {
    id: string; // 连接唯一标识
    source: string; // 源节点ID
    target: string; // 目标节点ID
    label?: string; // 连接标签
    style?: Record<string, any>; // 连接样式
    type?: 'straight' | 'curved' | 'bezier'; // 连接类型
    color?: string; // 连接颜色
    width?: number; // 连接宽度
}

export interface MindMapDoc {
    docType: document['TYPE_MINDMAP'];
    docId: ObjectId;
    domainId: string;
    mmid: number; // MindMap ID，从1开始（业务ID，用于路由显示）
    owner: number;
    title: string;
    content: string; // 描述性内容（可选）
    nodes: MindMapNode[]; // 节点列表（向后兼容，新数据存储在 branchData 中）
    edges: MindMapEdge[]; // 连接列表（向后兼容，新数据存储在 branchData 中）
    branchData?: { [branch: string]: { nodes: MindMapNode[]; edges: MindMapEdge[] } }; // 按分支存储的数据
    layout?: {
        type: 'hierarchical' | 'force' | 'manual'; // 布局类型
        direction?: 'LR' | 'RL' | 'TB' | 'BT'; // 布局方向（用于层级布局）
        spacing?: { x: number; y: number }; // 节点间距
        config?: Record<string, any>; // 布局配置
    };
    viewport?: {
        x: number; // 视口X坐标
        y: number; // 视口Y坐标
        zoom: number; // 缩放级别
    };
    theme?: {
        primaryColor?: string;
        backgroundColor?: string;
        nodeStyle?: Record<string, any>;
        edgeStyle?: Record<string, any>;
    };
    createdAt: Date;
    updateAt: Date;
    views: number;
    ip?: string;
    rpid?: number; // 可选的关联仓库ID
    branch?: string; // 可选的关联分支
    githubRepo?: string; // GitHub 仓库地址，如 git@github.com:user/repo.git
    branches?: string[]; // 分支列表
    currentBranch?: string; // 当前分支
    history?: MindMapHistoryEntry[]; // 操作历史记录（最多50条）
    files?: FileInfo[]; // 文件列表
}

export interface MindMapHistoryEntry {
    id: string; // 历史记录ID
    type: 'save' | 'commit'; // 操作类型
    timestamp: Date; // 操作时间
    userId: number; // 操作用户ID
    username: string; // 操作用户名
    description: string; // 操作描述
    snapshot: { // 数据快照
        nodes: MindMapNode[];
        edges: MindMapEdge[];
        viewport?: {
            x: number;
            y: number;
            zoom: number;
        };
    };
}

export interface CardDoc {
    docType: document['TYPE_CARD'];
    docId: ObjectId;
    domainId: string;
    mmid: number; // 关联的 mindmap ID
    nodeId: string; // 关联的 node ID
    cid: number; // Card ID，从1开始（在 node 内唯一）
    owner: number;
    title: string;
    content: string;
    ip?: string;
    updateAt: Date;
    views: number;
    createdAt?: Date;
    order?: number;
}

// Node document
declare module './model/node' {
    interface NodeDoc {
        _id: ObjectId; // document 系统自动添加
        docType: document['TYPE_NODE'];
        docId: ObjectId; // 由 mongo 自动生成
        domainId: string;
        nid: number; // Node ID，从 1 开始（业务 ID，用于路由显示）
        name: string;
        description?: string;
        wsEndpoint?: string; // WebSocket 接入点路径（可选，生成接入点时设置）
        mqttClientId?: string; // MQTT 客户端 ID
        status: 'active' | 'inactive' | 'disconnected';
        host?: string; // Node 主机地址
        port?: number; // Node 端口
        edgeId?: number; // 关联的 Edge ID（当通过 edge 接入时）
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
        docType: document['TYPE_EDGE'];
        docId: ObjectId; // 由 mongo 自动生成
        domainId: string;
        serverId: number; // MCP 服务器 ID，从 1 开始（业务 ID）
        name: string;
        description?: string;
        wsEndpoint: string; // WebSocket 接入点路径
        wsToken?: string; // WebSocket 连接令牌（用于验证）
        status?: 'connected' | 'disconnected' | 'error'; // 服务器连接状态（可选，由实时连接管理，不存储到数据库）
        lastConnectedAt?: Date; // 最后连接时间
        lastDisconnectedAt?: Date; // 最后断开时间
        errorMessage?: string; // 错误信息
        toolsCount?: number; // 工具数量
        type?: 'provider' | 'repo' | 'node'; // MCP 服务器类型：provider（外部）、repo（repo内部）、node（node提供）
        createdAt: Date;
        updatedAt: Date;
        owner: number; // 用户 ID
        content?: string; // document 系统要求
    }

    interface McpToolDoc {
        _id: ObjectId; // document 系统自动添加
        docType: document['TYPE_TOOL'];
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

// Client Chat document
declare module './model/client_chat' {
    interface ClientChatDoc {
        _id: ObjectId;
        docType: document['TYPE_CLIENT_CHAT'];
        docId: ObjectId;
        domainId: string;
        clientId: number;
        conversationId: number;
        messages: Array<{
            role: 'user' | 'assistant' | 'tool';
            content: string;
            timestamp: Date;
            toolName?: string;
            toolCallId?: string;
            responseTime?: number;
            asrAudioPath?: string;
            ttsAudioPath?: string;
        }>;
        messageCount: number;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
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
        edgeId?: number; // 关联的 Edge ID（当通过 edge 接入时）
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

declare module './model/edge' {
    interface EdgeDoc {
        _id: ObjectId;
        docType: document['TYPE_EDGE'];
        docId: ObjectId;
        domainId: string;
        eid: number; // Edge ID，从 1 开始（业务 ID，用于路由显示）
        token: string;
        type: 'provider' | 'client' | 'node' | 'repo';
        status: 'online' | 'offline' | 'working';
        tokenCreatedAt: Date;
        tokenUsedAt?: Date;
        name?: string;
        description?: string;
        wsEndpoint?: string;
        lastConnectedAt?: Date;
        lastDisconnectedAt?: Date;
        errorMessage?: string;
        toolsCount?: number;
        nodeId?: number; // 关联的 Node ID（当 type='node' 时）
        clientId?: number; // 关联的 Client ID（当 type='client' 时）
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }
}
export type { EdgeDoc } from './model/edge';

// Workflow document
declare module './model/workflow' {
    interface WorkflowDoc {
        _id: ObjectId;
        docType: document['TYPE_WORKFLOW'];
        docId: ObjectId;
        domainId: string;
        wid: number; // Workflow ID，从 1 开始（业务 ID）
        name: string;
        description?: string;
        status: 'active' | 'inactive' | 'paused';
        enabled: boolean;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string; // document 系统要求
    }
}

// Workflow Node document
declare module './model/workflow_node' {
    interface WorkflowNodeDoc {
        _id: ObjectId;
        docType: document['TYPE_WORKFLOW_NODE'];
        docId: ObjectId;
        domainId: string;
        workflowId: number; // 所属工作流 ID
        workflowDocId: ObjectId; // 所属工作流的 docId
        nid: number; // Node ID，在工作流内从 1 开始
        type: 'trigger' | 'action' | 'condition' | 'delay';
        nodeType: 'timer' | 'button' | 'device_control' | 'agent_message' | 'object_action' | 'agent_action' | 'condition' | 'delay' | 'start' | 'end' | 'receiver';
        name: string;
        position: { x: number; y: number }; // UI 位置
        config: Record<string, any>; // 节点配置，根据 nodeType 不同而不同
        connections: Array<{
            targetNodeId: number; // 目标节点 ID
            condition?: string; // 条件（用于 condition 节点）
        }>;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string; // document 系统要求
    }
}
export type { WorkflowDoc } from './model/workflow';
export type { WorkflowNodeDoc } from './model/workflow_node';

declare module './model/tool' {
    interface ToolDoc {
        _id: ObjectId;
        docType: document['TYPE_TOOL'];
        docId: ObjectId;
        domainId: string;
        token: string;
        edgeDocId: ObjectId;
        tid: number; // Tool ID，从 1 开始（业务 ID，用于路由显示）
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties?: Record<string, any>;
        };
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }
}
export type { ToolDoc } from './model/tool';
export type { ClientChatDoc } from './model/client_chat';

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
        'workflow_timer': import('./model/workflow_timer').WorkflowTimerDoc;
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
    base: typeof import('./model/repo').BaseModel,
    repo: typeof import('./model/repo').RepoModel,
    doc: typeof import('./model/repo').DocModel,
    block: typeof import('./model/repo').BlockModel,
    node: typeof import('./model/node').default,
    nodeDevice: typeof import('./model/node').NodeDeviceModel,
    edge: typeof import('./model/edge').default,
    tool: typeof import('./model/tool').default,
    workflow: typeof import('./model/workflow').default,
    workflowNode: typeof import('./model/workflow_node').default,
    workflowTimer: typeof import('./model/workflow_timer').default,
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
    'RepoAdd' | 'AgentAdd' | 'MindMapAdd' | 'Notification' | 'Nav' | 'UserDropdown' | 'DomainManage' | 'ControlPanel' | 'ProfileHeaderContact' | 'Home_Domain' | 'NavDropdown' | 'NavMainDropdown'
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


// Session
export interface SessionDoc {
    _id: ObjectId;
    domainId: string;
    agentId: string;
    uid: number;
    recordIds: ObjectId[];
    type: 'client' | 'chat'; // session 类型：client（客户端会话）、chat（聊天会话）
    title?: string;
    context?: any; // 共享的上下文信息，用于 session 内的所有 task
    createdAt: Date;
    updatedAt: Date;
    lastActivityAt?: Date;
    clientId?: number; 
}

// Extend RecordDoc to support agent tasks
declare module '@ejunz/common/types' {
    export interface RecordDoc {
        // Task fields (when lang === 'task')
        agentId?: string;
        sessionId?: ObjectId; // 关联的 session ID
        agentMessages?: Array<{
            role: 'user' | 'assistant' | 'tool';
            content: string;
            timestamp: Date;
            toolName?: string;
            toolResult?: any;
        }>;
        agentToolCallCount?: number;
        agentTotalToolCalls?: number;
        agentError?: {
            message: string;
            code?: string;
            stack?: string;
        };
    }
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