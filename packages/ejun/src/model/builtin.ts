import {
    getScoreColor, NORMAL_STATUS, PERM, PRIV, USER, STATUS, STATUS_CODES, STATUS_SHORT_TEXTS,
    STATUS_TEXTS, USER_GENDER_FEMALE, USER_GENDER_ICONS, USER_GENDER_MALE,
    USER_GENDER_OTHER, USER_GENDER_RANGE, USER_GENDERS,
} from '@ejunz/common';
import { logger } from '../logger';

export * from '@ejunz/common/permission';
export * from '@ejunz/common/status';

export const AGENT = {
    PERMISSION_LIST: 'agent:permission_list',
    PERMISSION_GET: 'agent:permission_get',
    ADDON_LIST: 'agent:addon_list',
    ADDON_GET: 'agent:addon_get',
    ADDON_INSTALL: 'agent:addon_install',
    ADDON_UNINSTALL: 'agent:addon_uninstall',
    ADDON_UPDATE: 'agent:addon_update',
    GROUP_LIST: 'agent:group_list',
    GROUP_SEARCH: 'agent:group_search',
    GROUP_GET: 'agent:group_get',
    GROUP_CREATE: 'agent:group_create',
    GROUP_UPDATE: 'agent:group_update',
    GROUP_DELETE: 'agent:group_delete',
    TEAM_LIST: 'agent:team_list',
    TEAM_GET: 'agent:team_get',
    TEAM_CREATE: 'agent:team_create',
    TEAM_UPDATE: 'agent:team_update',
    TEAM_DELETE: 'agent:team_delete',
    ROLE_LIST: 'agent:role_list',
    ROLE_GET: 'agent:role_get',
    ROLE_CREATE: 'agent:role_create',
    ROLE_UPDATE: 'agent:role_update',
    ROLE_DELETE: 'agent:role_delete',
    TEAM_CREATE_MANY: 'agent:team_create_many',
    TEAM_GET_MANY: 'agent:team_get_many',
    TEAM_UPDATE_MANY: 'agent:team_update_many',
    TEAM_DELETE_MANY: 'agent:team_delete_many',
    AGENT_LIST: 'agent:agent_list',
    AGENT_GET: 'agent:agent_get',
    AGENT_CREATE: 'agent:agent_create',
    AGENT_UPDATE: 'agent:agent_update',
    AGENT_DELETE: 'agent:agent_delete',
    AGENT_CREATE_MANY: 'agent:agent_create_many',
    AGENT_GET_MANY: 'agent:agent_get_many',
    AGENT_UPDATE_MANY: 'agent:agent_update_many',
    AGENT_DELETE_MANY: 'agent:agent_delete_many',
    SESSION_LIST: 'agent:session_list',
    SESSION_GET: 'agent:session_get',
    SESSION_CREATE: 'agent:session_create',
    SESSION_CREATE_MANY: 'agent:session_create_many',
    SESSION_UPDATE: 'agent:session_update',
    SESSION_DELETE: 'agent:session_delete',
    SESSION_GET_MANY: 'agent:session_get_many',
    SESSION_DELETE_MANY: 'agent:session_delete_many',
} as const;

export type AgentPermissionId = typeof AGENT[keyof typeof AGENT];
export const AGENT_TOOL_PERMISSION_DEFINITIONS: Record<AgentPermissionId, { toolName: string; name: string; access: 'read' | 'manage' }> = {
    [AGENT.PERMISSION_LIST]: { toolName: 'agent_permission_list', name: 'List Agent permissions', access: 'read' },
    [AGENT.PERMISSION_GET]: { toolName: 'agent_permission_get', name: 'Read an Agent permission', access: 'read' },
    [AGENT.ADDON_LIST]: { toolName: 'agent_addon_list', name: 'List Agent Addons', access: 'read' },
    [AGENT.ADDON_GET]: { toolName: 'agent_addon_get', name: 'Read an Agent Addon', access: 'read' },
    [AGENT.ADDON_INSTALL]: { toolName: 'agent_addon_install', name: 'Install an Agent Addon', access: 'manage' },
    [AGENT.ADDON_UNINSTALL]: { toolName: 'agent_addon_uninstall', name: 'Uninstall an Agent Addon', access: 'manage' },
    [AGENT.ADDON_UPDATE]: { toolName: 'agent_addon_update', name: 'Update an Agent Addon', access: 'manage' },
    [AGENT.GROUP_LIST]: { toolName: 'agent_group_list', name: 'List Groups', access: 'read' },
    [AGENT.GROUP_SEARCH]: { toolName: 'agent_group_search', name: 'Search Groups', access: 'read' },
    [AGENT.GROUP_GET]: { toolName: 'agent_group_get', name: 'Read a Group', access: 'read' },
    [AGENT.GROUP_CREATE]: { toolName: 'agent_group_create', name: 'Create a Group', access: 'manage' },
    [AGENT.GROUP_UPDATE]: { toolName: 'agent_group_update', name: 'Update a Group', access: 'manage' },
    [AGENT.GROUP_DELETE]: { toolName: 'agent_group_delete', name: 'Delete a Group', access: 'manage' },
    [AGENT.TEAM_LIST]: { toolName: 'agent_team_list', name: 'List Teams', access: 'read' },
    [AGENT.TEAM_GET]: { toolName: 'agent_team_get', name: 'Read a Team', access: 'read' },
    [AGENT.TEAM_CREATE]: { toolName: 'agent_team_create', name: 'Create a Team', access: 'manage' },
    [AGENT.TEAM_UPDATE]: { toolName: 'agent_team_update', name: 'Update a Team', access: 'manage' },
    [AGENT.TEAM_DELETE]: { toolName: 'agent_team_delete', name: 'Delete a Team', access: 'manage' },
    [AGENT.ROLE_LIST]: { toolName: 'agent_role_list', name: 'List Agent roles', access: 'read' },
    [AGENT.ROLE_GET]: { toolName: 'agent_role_get', name: 'Read an Agent role', access: 'read' },
    [AGENT.ROLE_CREATE]: { toolName: 'agent_role_create', name: 'Create an Agent role', access: 'manage' },
    [AGENT.ROLE_UPDATE]: { toolName: 'agent_role_update', name: 'Update an Agent role', access: 'manage' },
    [AGENT.ROLE_DELETE]: { toolName: 'agent_role_delete', name: 'Delete an Agent role', access: 'manage' },
    [AGENT.TEAM_CREATE_MANY]: { toolName: 'agent_team_create_many', name: 'Create Teams and Agents in bulk', access: 'manage' },
    [AGENT.TEAM_GET_MANY]: { toolName: 'agent_team_get_many', name: 'Read Teams and Agents in bulk', access: 'read' },
    [AGENT.TEAM_UPDATE_MANY]: { toolName: 'agent_team_update_many', name: 'Update Teams and Agents in bulk', access: 'manage' },
    [AGENT.TEAM_DELETE_MANY]: { toolName: 'agent_team_delete_many', name: 'Delete Teams and Agents in bulk', access: 'manage' },
    [AGENT.AGENT_LIST]: { toolName: 'agent_agent_list', name: 'List Agents', access: 'read' },
    [AGENT.AGENT_GET]: { toolName: 'agent_agent_get', name: 'Read an Agent', access: 'read' },
    [AGENT.AGENT_CREATE]: { toolName: 'agent_agent_create', name: 'Create an Agent', access: 'manage' },
    [AGENT.AGENT_UPDATE]: { toolName: 'agent_agent_update', name: 'Update an Agent', access: 'manage' },
    [AGENT.AGENT_DELETE]: { toolName: 'agent_agent_delete', name: 'Delete an Agent', access: 'manage' },
    [AGENT.AGENT_CREATE_MANY]: { toolName: 'agent_agent_create_many', name: 'Create Agents in bulk', access: 'manage' },
    [AGENT.AGENT_GET_MANY]: { toolName: 'agent_agent_get_many', name: 'Read Agents in bulk', access: 'read' },
    [AGENT.AGENT_UPDATE_MANY]: { toolName: 'agent_agent_update_many', name: 'Update Agents in bulk', access: 'manage' },
    [AGENT.AGENT_DELETE_MANY]: { toolName: 'agent_agent_delete_many', name: 'Delete Agents in bulk', access: 'manage' },
    [AGENT.SESSION_LIST]: { toolName: 'agent_session_list', name: 'List Agent sessions', access: 'read' },
    [AGENT.SESSION_GET]: { toolName: 'agent_session_get', name: 'Read an Agent session', access: 'read' },
    [AGENT.SESSION_CREATE]: { toolName: 'agent_session_create', name: 'Create an Agent session', access: 'manage' },
    [AGENT.SESSION_CREATE_MANY]: { toolName: 'agent_session_create_many', name: 'Create Agent sessions in bulk', access: 'manage' },
    [AGENT.SESSION_UPDATE]: { toolName: 'agent_session_update', name: 'Update an Agent session', access: 'manage' },
    [AGENT.SESSION_DELETE]: { toolName: 'agent_session_delete', name: 'Delete an Agent session', access: 'manage' },
    [AGENT.SESSION_GET_MANY]: { toolName: 'agent_session_get_many', name: 'Read Agent sessions in bulk', access: 'read' },
    [AGENT.SESSION_DELETE_MANY]: { toolName: 'agent_session_delete_many', name: 'Delete Agent sessions in bulk', access: 'manage' },
};

export const AGENT_TOOL_PERMISSIONS = Object.entries(AGENT_TOOL_PERMISSION_DEFINITIONS).map(([id, permission]) => ({
    id: id.slice('agent:'.length),
    name: permission.name,
    description: `Allows use of the ${permission.toolName} tool.`,
}));

export const Permission = (family: string, key: bigint, desc: string) => ({ family, key, desc });

export const PERMS = [
    Permission('perm_general', PERM.PERM_VIEW, 'View this domain'),
    Permission('perm_general', PERM.PERM_VIEW_USER_PRIVATE_INFO, 'View domain user private info'),
    Permission('perm_general', PERM.PERM_EDIT_DOMAIN, 'Edit domain settings'),
    Permission('perm_general', PERM.PERM_MOD_BADGE, 'Show MOD badge'),
    Permission('perm_discussion', PERM.PERM_VIEW_DISCUSSION, 'View discussions'),
    Permission('perm_discussion', PERM.PERM_CREATE_DISCUSSION, 'Create discussions'),
    Permission('perm_discussion', PERM.PERM_HIGHLIGHT_DISCUSSION, 'Highlight discussions'),
    Permission('perm_discussion', PERM.PERM_PIN_DISCUSSION, 'Pin discussions'),
    Permission('perm_discussion', PERM.PERM_EDIT_DISCUSSION, 'Edit discussions'),
    Permission('perm_discussion', PERM.PERM_EDIT_DISCUSSION_SELF, 'Edit own discussions'),
    Permission('perm_discussion', PERM.PERM_LOCK_DISCUSSION, 'Lock discussions'),
    Permission('perm_discussion', PERM.PERM_DELETE_DISCUSSION, 'Delete discussions'),
    Permission('perm_discussion', PERM.PERM_DELETE_DISCUSSION_SELF, 'Delete own discussions'),
    Permission('perm_discussion', PERM.PERM_REPLY_DISCUSSION, 'Reply discussions'),
    Permission('perm_discussion', PERM.PERM_ADD_REACTION, 'React to discussion'),
    Permission('perm_discussion', PERM.PERM_EDIT_DISCUSSION_REPLY_SELF, 'Edit own discussion replies'),
    Permission('perm_discussion', PERM.PERM_DELETE_DISCUSSION_REPLY, 'Delete discussion replies'),
    Permission('perm_discussion', PERM.PERM_DELETE_DISCUSSION_REPLY_SELF, 'Delete own discussion replies'),
    Permission('perm_discussion', PERM.PERM_DELETE_DISCUSSION_REPLY_SELF_DISCUSSION, 'Delete discussion replies of own discussion'),
    Permission('perm_agent', PERM.PERM_VIEW_AGENT, 'View Agent groups and workspace'),
    Permission('perm_agent', PERM.PERM_CREATE_AGENT, 'Create Agents and groups'),
    Permission('perm_agent', PERM.PERM_EDIT_AGENT, 'Edit shared Agent groups'),
    Permission('perm_agent', PERM.PERM_DELETE_AGENT, 'Delete shared Agent groups'),
    Permission('perm_agent', PERM.PERM_CONFIGURE_AGENT, 'Configure Agent add-ons and domain settings'),
    Permission('perm_ranking', PERM.PERM_VIEW_RANKING, 'View ranking'),
];

export const PERMS_BY_FAMILY = {};
for (const p of PERMS) {
    if (!PERMS_BY_FAMILY[p.family]) PERMS_BY_FAMILY[p.family] = [p];
    else PERMS_BY_FAMILY[p.family].push(p);
}

// people whose rank is less than 1% will get Level 10
export const LEVELS = [100, 90, 70, 55, 40, 30, 20, 10, 5, 2, 1];

export const BUILTIN_ROLES = {
    guest: PERM.PERM_BASIC,
    default: PERM.PERM_DEFAULT,
    root: PERM.PERM_ALL,
};

export const DEFAULT_NODES = {
    易君: [
        { pic: 'ejunz', name: 'Ejunz' },
        { pic: 'ejunz', name: '管理' },
        { pic: 'ejunz', name: '开发' },
        { pic: 'ejunz', name: '定制' },
        { pic: 'ejunz', name: '建议' },
    ],
    公开域: [
        { name: 'CS2' },
        { name: 'IELTS'}
    ],
    社区: [
        { name: '封禁' },
        { name: '举报' },
        { name: '建议' },
    ],
    域: [
        { name: '管理' },
        { name: '配置' },
        { name: '插件' },
        { name: '空间' },
    ],
    开发: [
        { name: '教程' },
        { name: '文档' },
    ],
    服务: [
        { name: '会员' },
        { name: '定制' },
        { name: '咨询' },
    ],
};

export const CATEGORIES = {
    Ejunz: ['易君理念', '易君框架', '易君文化', '易君历史', '易君展望'],
    系统: ['系统理念', '系统教程', '系统管理', '系统升级', '系统封禁', '系统插件'],
    UI: ['UI设计', 'Ui配置', 'UI开发', 'UI个性化', 'UI插件'],
    私域: ['私域理念', '私域教程', '私域管理', '私域定制', '私域封禁', '私域插件'],
    管理: ['管理员', '管理教程'],
    权限: ['权限系统', '用户管理', '角色管理', '小组管理', '权限管理', '权限配置'],
    配置: ['系统配置','私域配置', '主题样式', '用户个性化设置'],
    插件: ['插件系统', '插件教程', '官方插件', '第三方插件','插件开发', '插件市场',  '插件配置',  '插件权限', '插件使用'],
    空间: ['空间系统', '空间教程', '官方空间', '第三方空间',  '空间开发',  '空间市场',  '空间配置',  '空间权限',  '空间插件', '空间嵌套'],
    个人: ['用户主页', '自我成长', '储存管理', '个性化', '加入私域', '创建私域', '私域定制'],
    本地化: ['语言设置', '语言开发'],
    森林: ['森林理念', '森林教程', '森林开发', '森林管理', '森林定制'],
    知识库: ['知识库搭建', '个人知识库', '团队知识库', '知识库管理'],
    指导库: ['方法指引', '实践手册', '个人操作', '团队指导'],
    题库: ['题目制作', '题目消费', '题目列表', '题目分类', '标签系统', '题解与参考'],
    评测: ['评测指南', '题目评测', '评测记录'],
    训练: ['训练搭建', '训练计划', '训练记录', '训练管理'],
    作业: ['作业搭建', '作业教程', '作业管理', '作业定制'],
    竞赛: ['比赛举办', '内部赛', '公开赛', '模拟赛', '赛制与规则'],
    排名: ['排行榜', '积分系统', '头衔', '团队排名'],
    讨论: ['讨论节点', '衍生讨论', '讨论管理', '讨论封禁'],
    生产: ['内容创作', '任务协同', '共创机制', '内容审阅'],
    教程: ['入门教程', '进阶指南', '视频教学', '操作手册'],
    文档: ['系统文档', '用户文档', '开发文档', '协作说明', '插件文档', '空间文档'],
    杂项: ['杂谈', '无题', '实验性功能', '草稿区', '测试'],
    其他: ['迁移内容', '临时记录', '未来构想'],
  };

  export function registerPluginPermission(family: string, key: bigint, desc: string, plugin?: boolean, space?: boolean, name?: string) {
    if (plugin) {
        family = 'plugins';
    }
    const exists = PERMS.some((perm) => perm.key === key);
    if (exists) {
        const existingPerm = PERMS.find((perm) => perm.key === key);
        logger.warn(
            `Permission key ${key.toString()} already exists in family "${existingPerm?.family}" with description "${existingPerm?.desc}". Skipping registration.`
        );
        return;
    }

    if (!PERMS_BY_FAMILY[family]) {
        PERMS_BY_FAMILY[family] = [];
    }

    const permission = { family, key, desc, name };

    PERMS.push(permission);
    PERMS_BY_FAMILY[family].push(permission);
    logger.info(`Registered permission: family="${family}", key="${key.toString()}", desc="${desc}", name="${name}"`);
}

export function registerSpacePermission(family: string, key: bigint, desc: string, space?: boolean, name?: string) {
    if (space) {
        family = 'spaces';
    }
    const exists = PERMS.some((perm) => perm.key === key);
    if (exists) {
        const existingPerm = PERMS.find((perm) => perm.key === key);
        logger.warn(
            `Permission key ${key.toString()} already exists in family "${existingPerm?.family}" with description "${existingPerm?.desc}". Skipping registration.`
        );
        return;
    }

    if (!PERMS_BY_FAMILY[family]) {
        PERMS_BY_FAMILY[family] = [];
    }

    const permission = { family, key, desc, name };

    PERMS.push(permission);
    PERMS_BY_FAMILY[family].push(permission);
    logger.info(`Registered permission: family="${family}", key="${key.toString()}", desc="${desc}", name="${name}"`);
}


global.Ejunz.model.builtin = {
    Permission,
    getScoreColor,
    registerPluginPermission,
    registerSpacePermission,
    PERM,
    PERMS,
    PERMS_BY_FAMILY,
    PRIV,
    USER,
    AGENT,
    AGENT_TOOL_PERMISSION_DEFINITIONS,
    AGENT_TOOL_PERMISSIONS,
    LEVELS,
    BUILTIN_ROLES,
    DEFAULT_NODES,
    CATEGORIES,
    STATUS,
    STATUS_TEXTS,
    STATUS_SHORT_TEXTS,
    STATUS_CODES,
    NORMAL_STATUS,
    USER_GENDER_MALE,
    USER_GENDER_FEMALE,
    USER_GENDER_OTHER,
    USER_GENDERS,
    USER_GENDER_RANGE,
    USER_GENDER_ICONS,
};