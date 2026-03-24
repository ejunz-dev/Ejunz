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
        mcpToolIds?: ObjectId[]; // Comment translated to English.
        repoIds?: number[]; // Comment translated to English.
        skillIds?: string[]; // Assigned skill names; domain market tools only when referenced in these skills
        skillBranch?: string; // Comment translated to English.
    }
}
export type { AgentDoc } from './model/agent';

// Repo/Base/Doc/Block documents
export interface BaseDoc {
    docType: document['TYPE_BASE']; // Base 
    docId: number;
    domainId: string;
    rpids: number[]; // Comment translated to English.
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}

export interface RepoDoc {
    docType: document['TYPE_REPO'];  // Comment translated to English.
    docId: ObjectId;
    domainId: string;
    rpid: number;
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
    currentBranch?: string; // Comment translated to English.
    branches?: string[];    // Comment translated to English.
    githubRepo?: string;    // Comment translated to English.
    mode?: 'file' | 'manuscript'; // Comment translated to English.
    config?: Record<string, any>; // Comment translated to English.
    mcpServerId?: number; // Comment translated to English.
    edgeId?: number; // Comment translated to English.
}

export interface DocDoc {
    docType: document['TYPE_DOC'];
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number;  // Comment translated to English.
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
    branch?: string; // Comment translated to English.
    order?: number;
}

export interface BlockDoc {
    docType: document['TYPE_BLOCK'];
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number;  // Comment translated to English.
    bid: number;  // Comment translated to English.
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    createdAt?: Date;
    branch?: string; // Comment translated to English.
    order?: number;
}

// Base document
export interface BaseNode {
    id: string; // Comment translated to English.
    text: string; // Comment translated to English.
    x?: number; // Comment translated to English.
    y?: number; // Comment translated to English.
    width?: number; // Comment translated to English.
    height?: number; // Comment translated to English.
    color?: string; // Comment translated to English.
    backgroundColor?: string; // Comment translated to English.
    fontSize?: number; // Comment translated to English.
    shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond'; // Comment translated to English.
    parentId?: string; // Comment translated to English.
    children?: string[]; // Comment translated to English.
    expanded?: boolean; // Comment translated to English.
    level?: number; // Comment translated to English.
    order?: number; // Comment translated to English.
    style?: Record<string, any>; // Comment translated to English.
    data?: Record<string, any>; // Comment translated to English.
    /** Mounted files (uploaded to this node) */
    files?: FileInfo[];
    /** Optional intent / goal text for this node (shown aggregated on ancestors in the editor) */
    intent?: string;
}

export interface BaseEdge {
    id: string; // Comment translated to English.
    source: string; // Comment translated to English.
    target: string; // Comment translated to English.
    label?: string; // Comment translated to English.
    style?: Record<string, any>; // Comment translated to English.
    type?: 'straight' | 'curved' | 'bezier'; // Comment translated to English.
    color?: string; // Comment translated to English.
    width?: number; // Comment translated to English.
}

export interface BaseDoc {
    docType: document['TYPE_BASE'];
    docId: number;
    domainId: string;
    owner: number;
    title: string;
    content: string; // Comment translated to English.
    type?: 'base' | 'skill';
    nodes: BaseNode[]; // Comment translated to English.
    edges: BaseEdge[]; // Comment translated to English.
    branchData?: { [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] } }; // Comment translated to English.
    layout?: {
        type: 'hierarchical' | 'force' | 'manual'; // Comment translated to English.
        direction?: 'LR' | 'RL' | 'TB' | 'BT'; // Comment translated to English.
        spacing?: { x: number; y: number }; // Comment translated to English.
        config?: Record<string, any>; // Comment translated to English.
    };
    viewport?: {
        x: number; // Comment translated to English.
        y: number; // Comment translated to English.
        zoom: number; // Comment translated to English.
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
    rpid?: number; // Comment translated to English.
    bid?: string | number; // Comment translated to English.
    branch?: string; // Comment translated to English.
    githubRepo?: string; // Comment translated to English.
    branches?: string[]; // Comment translated to English.
    currentBranch?: string; // Comment translated to English.
    parentId?: ObjectId; // Comment translated to English.
    domainPosition?: { x: number; y: number }; // Comment translated to English.
    history?: BaseHistoryEntry[]; // Comment translated to English.
    files?: FileInfo[]; // Comment translated to English.
}

export interface BaseHistoryEntry {
    id: string; // Comment translated to English.
    type: 'save' | 'commit'; // Comment translated to English.
    timestamp: Date; // Comment translated to English.
    userId: number; // Comment translated to English.
    username: string; // Comment translated to English.
    description: string; // Comment translated to English.
    snapshot: { // Comment translated to English.
        nodes: BaseNode[];
        edges: BaseEdge[];
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
    baseDocId: number | ObjectId; // Comment translated to English.
    nodeId: string; // Comment translated to English.
    cid: number; // Comment translated to English.
    owner: number;
    title: string;
    content: string;
    /* Comment translated to English. */
    cardFace?: string;
    ip?: string;
    updateAt: Date;
    views: number;
    createdAt?: Date;
    order?: number;
    // Comment translated to English.
    problems?: {
        pid: string;          // Comment translated to English.
        type: 'single';       // Comment translated to English.
        stem: string;         // Comment translated to English.
        options: string[];    // Comment translated to English.
        answer: number;       // Comment translated to English.
        analysis?: string;    // Comment translated to English.
    }[];
    /** Mounted files (uploaded to this card) */
    files?: FileInfo[];
}

// Node document
declare module './model/node' {
    interface NodeDoc {
        _id: ObjectId; // Comment translated to English.
        docType: document['TYPE_NODE'];
        docId: ObjectId; // Comment translated to English.
        domainId: string;
        nid: number; // Comment translated to English.
        name: string;
        description?: string;
        wsEndpoint?: string; // Comment translated to English.
        mqttClientId?: string; // Comment translated to English.
        status: 'active' | 'inactive' | 'disconnected';
        host?: string; // Comment translated to English.
        port?: number; // Comment translated to English.
        edgeId?: number; // Comment translated to English.
        createdAt: Date;
        updatedAt: Date;
        owner: number; // Comment translated to English.
        content?: string; // Comment translated to English.
    }
}
export type { NodeDoc } from './model/node';

// Scene document
declare module './model/scene' {
    interface SceneDoc {
        _id: ObjectId; // Comment translated to English.
        docType: document['TYPE_SCENE'];
        docId: ObjectId; // Comment translated to English.
        domainId: string;
        sid: number; // Comment translated to English.
        name: string;
        description?: string;
        enabled: boolean; // Comment translated to English.
        createdAt: Date;
        updatedAt: Date;
        owner: number; // Comment translated to English.
        content?: string; // Comment translated to English.
    }

    interface SceneEventDoc {
        _id: ObjectId; // Comment translated to English.
        docType: document['TYPE_EVENT'];
        docId: ObjectId; // Comment translated to English.
        domainId: string;
        sceneId: number; // Comment translated to English.
        sceneDocId: ObjectId; // Comment translated to English.
        parentType: document['TYPE_SCENE']; // Comment translated to English.
        parentId: ObjectId; // Comment translated to English.
        eid: number; // Comment translated to English.
        name: string;
        description?: string;
        // Comment translated to English.
        sourceNodeId?: number; // Comment translated to English.
        sourceDeviceId?: string; // Comment translated to English.
        sourceClientId?: number; // Comment translated to English.
        sourceWidgetName?: string; // Comment translated to English.
        sourceGsiPath?: string; // Comment translated to English.
        sourceGsiOperator?: string; // Comment translated to English.
        sourceGsiValue?: any; // Comment translated to English.
        sourceAction?: string; // Comment translated to English.
        // Comment translated to English.
        targets: Array<{ // Comment translated to English.
            targetNodeId?: number; // Comment translated to English.
            targetDeviceId?: string; // Comment translated to English.
            targetClientId?: number; // Comment translated to English.
            targetWidgetName?: string; // Comment translated to English.
            targetAction: string;
            targetValue?: any;
            order?: number; // Execution order
            triggerType?: 'single' | 'echo'; // Trigger effect type: single or echo (default single)
            echoDelayMs?: number; // For echo: delay in ms before executing again
            initialState?: 'on' | 'off'; // Initial state (on/off), applied to all effects before actions when event triggers
        }>;
        enabled: boolean; // Whether this event is enabled
        triggerLimit?: number; // Max trigger count (0 = unlimited, -1 = once)
        triggerDelay?: number; // Delay before trigger (ms)
        createdAt: Date;
        updatedAt: Date;
        owner: number; // Comment translated to English.
        content?: string; // Comment translated to English.
    }
}
export type { SceneDoc, SceneEventDoc } from './model/scene';

// MCP Server document
declare module './model/mcp' {
    interface McpServerDoc {
        _id: ObjectId; // Comment translated to English.
        docType: document['TYPE_EDGE'];
        docId: ObjectId; // Comment translated to English.
        domainId: string;
        serverId: number; // Comment translated to English.
        name: string;
        description?: string;
        wsEndpoint: string; // Comment translated to English.
        wsToken?: string; // Comment translated to English.
        status?: 'connected' | 'disconnected' | 'error'; // Comment translated to English.
        lastConnectedAt?: Date; // Comment translated to English.
        lastDisconnectedAt?: Date; // Comment translated to English.
        errorMessage?: string; // Comment translated to English.
        toolsCount?: number; // Comment translated to English.
        type?: 'provider' | 'repo' | 'node'; // Comment translated to English.
        createdAt: Date;
        updatedAt: Date;
        owner: number; // Comment translated to English.
        content?: string; // Comment translated to English.
    }

    interface McpToolDoc {
        _id: ObjectId; // Comment translated to English.
        docType: document['TYPE_TOOL'];
        docId: ObjectId; // Comment translated to English.
        domainId: string;
        serverId: number; // Comment translated to English.
        serverDocId: ObjectId; // Comment translated to English.
        toolId: number; // Comment translated to English.
        name: string; // Comment translated to English.
        description: string; // Comment translated to English.
        inputSchema: {
            type: string;
            properties?: Record<string, any>;
        }; // Comment translated to English.
        createdAt: Date;
        updatedAt: Date;
        owner: number; // Comment translated to English.
        content?: string; // Comment translated to English.
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
        edgeId?: number; // Comment translated to English.
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
            voiceCloning?: {
                voices: Array<{
                    voiceId: string;
                    preferredName: string;
                    region: string;
                    createdAt: Date;
                    updatedAt: Date;
                }>;
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
        eid: number; // Comment translated to English.
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
        nodeId?: number; // Comment translated to English.
        clientId?: number; // Comment translated to English.
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
        wid: number; // Comment translated to English.
        name: string;
        description?: string;
        status: 'active' | 'inactive' | 'paused';
        enabled: boolean;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string; // Comment translated to English.
    }
}

// Workflow Node document
declare module './model/workflow_node' {
    interface WorkflowNodeDoc {
        _id: ObjectId;
        docType: document['TYPE_WORKFLOW_NODE'];
        docId: ObjectId;
        domainId: string;
        workflowId: number; // Comment translated to English.
        workflowDocId: ObjectId; // Comment translated to English.
        nid: number; // Comment translated to English.
        type: 'trigger' | 'action' | 'condition' | 'delay';
        nodeType: 'timer' | 'button' | 'device_control' | 'agent_message' | 'object_action' | 'agent_action' | 'condition' | 'delay' | 'start' | 'end' | 'receiver';
        name: string;
        position: { x: number; y: number }; // Comment translated to English.
        config: Record<string, any>; // Comment translated to English.
        connections: Array<{
            targetNodeId: number; // Comment translated to English.
            condition?: string; // Comment translated to English.
        }>;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string; // Comment translated to English.
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
        tid: number; // Comment translated to English.
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

/* Comment translated to English. */
export interface AssignedToolEntry {
    name: string;
    description: string;
    inputSchema: any;
    token?: string;
    edgeId?: ObjectId;
    type?: 'system';
    /* Comment translated to English. */
    system?: boolean;
}
export type { DomainMarketToolDoc } from './model/domain_market_tool';
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
        'client.widget': import('./model/client').ClientWidgetDoc;
        'client.gsifield': import('./model/client').ClientGsiFieldDoc;
        'workflow_timer': import('./model/workflow_timer').WorkflowTimerDoc;
        'learn_dag': any;
        'learn_progress': any;
        'learn_result': any;
        'learn_consumption_stats': any;
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
    node: typeof import('./model/node').default,
    nodeDevice: typeof import('./model/node').NodeDeviceModel,
    clientWidget: typeof import('./model/client').ClientWidgetModel,
    edge: typeof import('./model/edge').default,
    tool: typeof import('./model/tool').default,
    workflow: typeof import('./model/workflow').default,
    workflowNode: typeof import('./model/workflow_node').default,
    workflowTimer: typeof import('./model/workflow_timer').default,
    learn: typeof import('./model/learn').default,
    scene: typeof import('./model/scene').default,
    sceneEvent: typeof import('./model/scene').SceneEventModel,
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
    'RepoAdd' | 'AgentAdd' | 'BaseAdd' | 'Notification' | 'Nav' | 'UserDropdown' | 'DomainManage' | 'ControlPanel' | 'ProfileHeaderContact' | 'Home_Domain' | 'NavDropdown' | 'NavMainDropdown'
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
    type: 'client' | 'chat'; // Comment translated to English.
    title?: string;
    context?: any; // Comment translated to English.
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
        sessionId?: ObjectId; // Comment translated to English.
        agentMessages?: Array<{
            role: 'user' | 'assistant' | 'tool';
            content: string;
            timestamp: Date;
            bubbleId?: string; // Unique message ID for deduplication
            toolName?: string;
            toolResult?: any;
            tool_call_id?: string;
            tool_calls?: any[];
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