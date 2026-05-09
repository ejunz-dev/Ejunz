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
        mcpToolIds?: ObjectId[];
        repoIds?: number[];
        skillIds?: string[]; // Assigned skill names; domain market tools only when referenced in these skills
        skillBranch?: string;
    }
}
export type { AgentDoc } from './model/agent';

// Repo/Base/Doc/Block documents
export interface BaseDoc {
    docType: document['TYPE_BASE']; // Base 
    docId: number;
    domainId: string;
    rpids: number[];
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}

export interface RepoDoc {
    docType: document['TYPE_REPO']; 
    docId: ObjectId;
    domainId: string;
    rpid: number;
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
    currentBranch?: string;
    branches?: string[];   
    githubRepo?: string;   
    mode?: 'file' | 'manuscript';
    config?: Record<string, any>;
    mcpServerId?: number;
    edgeId?: number;
}

export interface DocDoc {
    docType: document['TYPE_DOC'];
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number; 
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
    branch?: string;
    order?: number;
}

export interface BlockDoc {
    docType: document['TYPE_BLOCK'];
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number; 
    bid: number; 
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    createdAt?: Date;
    branch?: string;
    order?: number;
}

// Base document
export interface BaseNode {
    id: string;
    text: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    color?: string;
    backgroundColor?: string;
    fontSize?: number;
    shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
    parentId?: string;
    children?: string[];
    expanded?: boolean;
    level?: number;
    order?: number;
    style?: Record<string, any>;
    data?: Record<string, any>;
    /** Mounted files (uploaded to this node) */
    files?: FileInfo[];
}

export interface BaseEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    style?: Record<string, any>;
    type?: 'straight' | 'curved' | 'bezier';
    color?: string;
    width?: number;
}

export interface BaseDoc {
    docType: document['TYPE_BASE'];
    docId: number;
    domainId: string;
    owner: number;
    title: string;
    content: string;
    type?: 'base' | 'skill' | 'training';
    nodes: BaseNode[];
    edges: BaseEdge[];
    branchData?: { [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] } };
    layout?: {
        type: 'hierarchical' | 'force' | 'manual';
        direction?: 'LR' | 'RL' | 'TB' | 'BT';
        spacing?: { x: number; y: number };
        config?: Record<string, any>;
    };
    viewport?: {
        x: number;
        y: number;
        zoom: number;
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
    rpid?: number;
    bid?: string | number;
    branch?: string;
    githubRepo?: string;
    branches?: string[];
    currentBranch?: string;
    parentId?: ObjectId;
    domainPosition?: { x: number; y: number };
    history?: BaseHistoryEntry[];
    files?: FileInfo[];
}

export interface BaseHistoryEntry {
    id: string;
    type: 'save' | 'commit';
    timestamp: Date;
    userId: number;
    username: string;
    description: string;
    snapshot: {
        nodes: BaseNode[];
        edges: BaseEdge[];
        viewport?: {
            x: number;
            y: number;
            zoom: number;
        };
    };
}

/** Card-attached practice problems (editor + lesson). Legacy rows omit `type` → single choice. */
export type ProblemKind = 'single' | 'multi' | 'true_false' | 'flip' | 'fill_blank' | 'matching';

export interface ProblemCommon {
    pid: string;
    /** Short label for lesson sidebars / lists; full stem still shows in practice. */
    title?: string;
    analysis?: string;
    imageUrl?: string;
    imageNote?: string;
}

/** Single choice (default when `type` omitted). */
export interface ProblemSingle extends ProblemCommon {
    type?: 'single';
    stem: string;
    options: string[];
    answer: number;
    /** Editor: number of option slots (2–8). */
    optionSlots?: number;
}

export interface ProblemMulti extends ProblemCommon {
    type: 'multi';
    stem: string;
    options: string[];
    /** Correct option indices; learner must match exactly. */
    answer: number[];
    optionSlots?: number;
}

/** True/false: 0 = false, 1 = true */
export interface ProblemTrueFalse extends ProblemCommon {
    type: 'true_false';
    stem: string;
    answer: 0 | 1;
}

/** Flip card: show face A, then face B after user taps know / not sure. Optional `hint` is learner-visible when they tap Hint (before/at flip). */
export interface ProblemFlip extends ProblemCommon {
    type: 'flip';
    faceA: string;
    faceB: string;
    /** Optional short cue for the learner; shown only after tapping Hint in lesson. */
    hint?: string;
}

/**
 * Fill-in-the-blank: use `___` (three underscores) in `stem` for each blank.
 * If `stem` has no `___`, a single blank is assumed after the whole stem.
 * `answers[i]` is the correct text for the i-th blank (order left-to-right).
 */
export interface ProblemFillBlank extends ProblemCommon {
    type: 'fill_blank';
    stem: string;
    answers: string[];
}

/** Pair rows across columns `columns[*][rowIndex]`; in the lesson every column uses an independent shuffled dropdown per row (`matchingAllColumnsCorrect`). Legacy docs may omit `columns`. */
export interface ProblemMatching extends ProblemCommon {
    type: 'matching';
    stem?: string;
    /** `columns[col][row]`; when absent, derive from left/right as two columns. */
    columns?: string[][];
    left: string[];
    right: string[];
}

export type Problem =
    | ProblemSingle
    | ProblemMulti
    | ProblemTrueFalse
    | ProblemFlip
    | ProblemFillBlank
    | ProblemMatching;

export interface CardDoc {
    docType: document['TYPE_CARD'];
    docId: ObjectId;
    domainId: string;
    baseDocId: number | ObjectId;
    nodeId: string;
    cid: number;
    owner: number;
    title: string;
    content: string;
    cardFace?: string;
    ip?: string;
    updateAt: Date;
    views: number;
    createdAt?: Date;
    order?: number;

    problems?: Problem[];
    /** Mounted files (uploaded to this card) */
    files?: FileInfo[];
}

// Node document
declare module './model/node' {
    interface NodeDoc {
        _id: ObjectId;
        docType: document['TYPE_NODE'];
        docId: ObjectId;
        domainId: string;
        nid: number;
        name: string;
        description?: string;
        wsEndpoint?: string;
        mqttClientId?: string;
        status: 'active' | 'inactive' | 'disconnected';
        host?: string;
        port?: number;
        edgeId?: number;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }
}
export type { NodeDoc } from './model/node';

// Scene document
declare module './model/scene' {
    interface SceneDoc {
        _id: ObjectId;
        docType: document['TYPE_SCENE'];
        docId: ObjectId;
        domainId: string;
        sid: number;
        name: string;
        description?: string;
        enabled: boolean;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }

    interface SceneEventDoc {
        _id: ObjectId;
        docType: document['TYPE_EVENT'];
        docId: ObjectId;
        domainId: string;
        sceneId: number;
        sceneDocId: ObjectId;
        parentType: document['TYPE_SCENE'];
        parentId: ObjectId;
        eid: number;
        name: string;
        description?: string;
       
        sourceNodeId?: number;
        sourceDeviceId?: string;
        sourceClientId?: number;
        sourceWidgetName?: string;
        sourceGsiPath?: string;
        sourceGsiOperator?: string;
        sourceGsiValue?: any;
        sourceAction?: string;
       
        targets: Array<{
            targetNodeId?: number;
            targetDeviceId?: string;
            targetClientId?: number;
            targetWidgetName?: string;
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
        owner: number;
        content?: string;
    }
}
export type { SceneDoc, SceneEventDoc } from './model/scene';

// MCP Server document
declare module './model/mcp' {
    interface McpServerDoc {
        _id: ObjectId;
        docType: document['TYPE_EDGE'];
        docId: ObjectId;
        domainId: string;
        serverId: number;
        name: string;
        description?: string;
        wsEndpoint: string;
        wsToken?: string;
        status?: 'connected' | 'disconnected' | 'error';
        lastConnectedAt?: Date;
        lastDisconnectedAt?: Date;
        errorMessage?: string;
        toolsCount?: number;
        type?: 'provider' | 'repo' | 'node';
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }

    interface McpToolDoc {
        _id: ObjectId;
        docType: document['TYPE_TOOL'];
        docId: ObjectId;
        domainId: string;
        serverId: number;
        serverDocId: ObjectId;
        toolId: number;
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
        edgeId?: number;
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
        eid: number;
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
        nodeId?: number;
        clientId?: number;
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
        wid: number;
        name: string;
        description?: string;
        status: 'active' | 'inactive' | 'paused';
        enabled: boolean;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }
}

// Workflow Node document
declare module './model/workflow_node' {
    interface WorkflowNodeDoc {
        _id: ObjectId;
        docType: document['TYPE_WORKFLOW_NODE'];
        docId: ObjectId;
        domainId: string;
        workflowId: number;
        workflowDocId: ObjectId;
        nid: number;
        type: 'trigger' | 'action' | 'condition' | 'delay';
        nodeType: 'timer' | 'button' | 'device_control' | 'agent_message' | 'object_action' | 'agent_action' | 'condition' | 'delay' | 'start' | 'end' | 'receiver';
        name: string;
        position: { x: number; y: number };
        config: Record<string, any>;
        connections: Array<{
            targetNodeId: number;
            condition?: string;
        }>;
        createdAt: Date;
        updatedAt: Date;
        owner: number;
        content?: string;
    }
}
export type { WorkflowDoc } from './model/workflow';
export type { WorkflowNodeDoc } from './model/workflow_node';

/** One Base + branch pair that contributes problems to the plan. */
export interface TrainingPlanSource {
    baseDocId: number;
    sourceBranch: string;
    targetBranch: string;
}

/**
 * Optional DAG over sections (Hydro-style _id / requireNids).
 * Section at index i uses dag[i]; requireNids reference other nodes' _id (mapped to section indices).
 */
export interface TrainingDagNode {
    _id: number;
    title: string;
    requireNids: number[];
}

/** Row in a training section problem table. */
export interface TrainingProblemRow {
    source?: string;
    pid?: string;
    title: string;
    tried?: number;
    ac?: number;
    difficulty?: number;
    nodeId?: string;
}

/** Collapsible section on training plan detail (e.g. Section 1 …). */
export interface TrainingSection {
    title: string;
    description?: string;
    status?: 'open' | 'locked' | 'invalid';
    /** Zero-based indices of sections that must be completed first (for locked note). */
    requireSectionIndexes?: number[];
    problems: TrainingProblemRow[];
}

export interface TrainingDoc {
    _id: ObjectId;
    docType: document['TYPE_TRAINING'];
    docId: ObjectId;
    domainId: string;
    name: string;
    description?: string;
    introQuote?: string;
    /** All Base+branch pairs composed into this plan (ordered). */
    planSources?: TrainingPlanSource[];
    /** Optional DAG metadata aligned by index with `sections`. */
    dag?: TrainingDagNode[];
    sections: TrainingSection[];
    enrollCount?: number;
    createdAt: Date;
    updatedAt: Date;
    owner: number;
    content?: string;
}

declare module './model/tool' {
    interface ToolDoc {
        _id: ObjectId;
        docType: document['TYPE_TOOL'];
        docId: ObjectId;
        domainId: string;
        token: string;
        edgeDocId: ObjectId;
        tid: number;
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

export interface AssignedToolEntry {
    name: string;
    description: string;
    inputSchema: any;
    token?: string;
    edgeId?: ObjectId;
    type?: 'system';
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
        'develop_branch_daily': any;
        /** Per-domain user lesson/live progress (Learn). */
        'session': SessionDoc;
        'session_record': import('./model/record').SessionRecordDoc;
        /** Judge / worker submission rows (Mongo `record`, not session_record). */
        'record': import('@ejunz/common/types').RecordDoc;
        'record_history': any;
        'rating': any;
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
    session: typeof import('./model/session').default,
    record: typeof import('./model/record').default,
    rating: typeof import('./model/rating').default,
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

export type { SessionRecordDoc, RecordProblemState } from './model/record';

export type LessonMode = 'today' | 'node' | 'card' | null;

export interface LessonCardQueueItem {
    domainId: string;
    nodeId: string;
    cardId: string;
    nodeTitle?: string;
    cardTitle?: string;
    baseDocId?: number;
    learnSectionOrderIndex?: number;
    todayQueueRole?: 'new' | 'review';
}

export interface SessionDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    baseDocId?: number;
    branch?: string;
    cardId?: string;
    nodeId?: string;
    cardIndex?: number;
    route?: string;
    appRoute?: 'learn' | 'develop' | 'agent';
    developSessionKind?: 'daily' | 'outline_node';
    agentId?: string;
    agentSessionKind?: 'chat' | 'client';
    title?: string;
    context?: any;
    clientId?: number;
    lessonMode?: LessonMode;
    currentLearnSectionIndex?: number;
    currentLearnSectionId?: string;
    lessonReviewCardIds?: string[];
    lessonCardTimesMs?: number[];
    lessonCardQueue?: LessonCardQueueItem[];
    lessonQueueAnchorNodeId?: string | null;
    lessonQueueBaseDocId?: number | null;
    lessonQueueLearnBranch?: string | null;
    lessonQueueDay?: string | null;
    lessonQueueLearnSectionOrder?: string[];
    lessonQueueLearnStartCardId?: string | null;
    lessonQueueLearnSectionOrderIndex?: number | null;
    lessonQueueLearnSessionMode?: string | null;
    lessonQueueLearnSubMode?: string | null;
    lessonQueueLearnNewReviewRatio?: number | null;
    lessonQueueLearnNewReviewOrder?: string | null;
    lessonQueueLearnMixedSchedule?: string | null;
    lessonQueueMixedLayoutVersion?: number | null;
    lessonAbandonedAt?: Date | null;
    state?: 'idle' | 'active';
    progress?: Record<string, unknown>;
    recordIds?: ObjectId[];
    lastActivityAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

export type SessionPatch = Partial<Pick<
    SessionDoc,
    | 'baseDocId'
    | 'branch'
    | 'cardId'
    | 'nodeId'
    | 'cardIndex'
    | 'route'
    | 'appRoute'
    | 'developSessionKind'
    | 'lessonMode'
    | 'currentLearnSectionIndex'
    | 'currentLearnSectionId'
    | 'lessonReviewCardIds'
    | 'lessonCardTimesMs'
    | 'lessonCardQueue'
    | 'lessonQueueAnchorNodeId'
    | 'lessonQueueBaseDocId'
    | 'lessonQueueLearnBranch'
    | 'lessonQueueDay'
    | 'lessonQueueLearnSectionOrder'
    | 'lessonQueueLearnStartCardId'
    | 'lessonQueueLearnSectionOrderIndex'
    | 'lessonQueueLearnSessionMode'
    | 'lessonQueueLearnSubMode'
    | 'lessonQueueLearnNewReviewRatio'
    | 'lessonQueueLearnNewReviewOrder'
    | 'lessonQueueLearnMixedSchedule'
    | 'lessonQueueMixedLayoutVersion'
    | 'lessonAbandonedAt'
    | 'state'
    | 'progress'
    | 'agentId'
    | 'agentSessionKind'
    | 'title'
    | 'context'
    | 'clientId'
>>;

export interface AgentChatSessionDoc {
    _id: ObjectId;
    domainId: string;
    agentId: string;
    uid: number;
    recordIds: ObjectId[];
    type: 'client' | 'chat';
    title?: string;
    context?: any;
    createdAt: Date;
    updatedAt: Date;
    lastActivityAt?: Date;
    clientId?: number;
}

declare module '@ejunz/common/types' {
    /** Mongo `record` collection (judge / worker submission, including agent task rows). */
    export interface RecordDoc extends RecordPayload {
        _id: import('mongodb').ObjectId;
        agentId?: string;
        agentChatSessionId?: import('mongodb').ObjectId;
        agentMessages?: Array<{
            role: 'user' | 'assistant' | 'tool';
            content: string;
            timestamp: Date;
            bubbleId?: string;
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