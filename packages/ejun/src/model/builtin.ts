import {
    getScoreColor, NORMAL_STATUS, PERM, PRIV, STATUS, STATUS_CODES, STATUS_SHORT_TEXTS,
    STATUS_TEXTS, USER_GENDER_FEMALE, USER_GENDER_ICONS, USER_GENDER_MALE,
    USER_GENDER_OTHER, USER_GENDER_RANGE, USER_GENDERS,
} from '@ejunz/common';
import { logger } from '../logger';

export * from '@ejunz/common/permission';
export * from '@ejunz/common/status';

export const Permission = (family: string, key: bigint, desc: string) => ({ family, key, desc });

export const PERMS = [
    Permission('perm_general', PERM.USER_PERM_VIEW, 'View this domain'),
    Permission('perm_general', PERM.USER_PERM_VIEW_USER_PRIVATE_INFO, 'View domain user private info'),
    Permission('perm_general', PERM.USER_PERM_EDIT_DOMAIN, 'Edit domain settings'),
    Permission('perm_general', PERM.USER_PERM_MOD_BADGE, 'Show MOD badge'),
    Permission('perm_discussion', PERM.USER_PERM_VIEW_DISCUSSION, 'View discussions'),
    Permission('perm_discussion', PERM.USER_PERM_CREATE_DISCUSSION, 'Create discussions'),
    Permission('perm_discussion', PERM.USER_PERM_HIGHLIGHT_DISCUSSION, 'Highlight discussions'),
    Permission('perm_discussion', PERM.USER_PERM_PIN_DISCUSSION, 'Pin discussions'),
    Permission('perm_discussion', PERM.USER_PERM_EDIT_DISCUSSION, 'Edit discussions'),
    Permission('perm_discussion', PERM.USER_PERM_EDIT_DISCUSSION_SELF, 'Edit own discussions'),
    Permission('perm_discussion', PERM.USER_PERM_LOCK_DISCUSSION, 'Lock discussions'),
    Permission('perm_discussion', PERM.USER_PERM_DELETE_DISCUSSION, 'Delete discussions'),
    Permission('perm_discussion', PERM.USER_PERM_DELETE_DISCUSSION_SELF, 'Delete own discussions'),
    Permission('perm_discussion', PERM.USER_PERM_REPLY_DISCUSSION, 'Reply discussions'),
    Permission('perm_discussion', PERM.USER_PERM_ADD_REACTION, 'React to discussion'),
    Permission('perm_discussion', PERM.USER_PERM_EDIT_DISCUSSION_REPLY_SELF, 'Edit own discussion replies'),
    Permission('perm_discussion', PERM.USER_PERM_DELETE_DISCUSSION_REPLY, 'Delete discussion replies'),
    Permission('perm_discussion', PERM.USER_PERM_DELETE_DISCUSSION_REPLY_SELF, 'Delete own discussion replies'),
    Permission('perm_discussion', PERM.USER_PERM_DELETE_DISCUSSION_REPLY_SELF_DISCUSSION, 'Delete discussion replies of own discussion'),
    Permission('perm_agent', PERM.USER_PERM_VIEW_AGENT, 'View Agent groups and workspace'),
    Permission('perm_agent', PERM.USER_PERM_CREATE_AGENT, 'Create Agents and groups'),
    Permission('perm_agent', PERM.USER_PERM_EDIT_AGENT, 'Edit shared Agent groups'),
    Permission('perm_agent', PERM.USER_PERM_DELETE_AGENT, 'Delete shared Agent groups'),
    Permission('perm_agent', PERM.USER_PERM_CONFIGURE_AGENT, 'Configure Agent add-ons and domain settings'),
    Permission('perm_agent', PERM.AGENT_PERM_PERMISSION_LIST, 'List Agent permissions'),
    Permission('perm_agent', PERM.AGENT_PERM_PERMISSION_GET, 'Read an Agent permission'),
    Permission('perm_agent', PERM.AGENT_PERM_ADDON_LIST, 'List Agent Addons'),
    Permission('perm_agent', PERM.AGENT_PERM_ADDON_GET, 'Read an Agent Addon'),
    Permission('perm_agent', PERM.AGENT_PERM_ADDON_INSTALL, 'Install an Agent Addon'),
    Permission('perm_agent', PERM.AGENT_PERM_ADDON_UNINSTALL, 'Uninstall an Agent Addon'),
    Permission('perm_agent', PERM.AGENT_PERM_ADDON_UPDATE, 'Update an Agent Addon'),
    Permission('perm_agent', PERM.AGENT_PERM_GROUP_LIST, 'List Groups'),
    Permission('perm_agent', PERM.AGENT_PERM_GROUP_SEARCH, 'Search Groups'),
    Permission('perm_agent', PERM.AGENT_PERM_GROUP_GET, 'Read a Group'),
    Permission('perm_agent', PERM.AGENT_PERM_GROUP_CREATE, 'Create a Group'),
    Permission('perm_agent', PERM.AGENT_PERM_GROUP_UPDATE, 'Update a Group'),
    Permission('perm_agent', PERM.AGENT_PERM_GROUP_DELETE, 'Delete a Group'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_LIST, 'List Teams'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_GET, 'Read a Team'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_CREATE, 'Create a Team'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_UPDATE, 'Update a Team'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_DELETE, 'Delete a Team'),
    Permission('perm_agent', PERM.AGENT_PERM_ROLE_LIST, 'List Agent roles'),
    Permission('perm_agent', PERM.AGENT_PERM_ROLE_GET, 'Read an Agent role'),
    Permission('perm_agent', PERM.AGENT_PERM_ROLE_CREATE, 'Create an Agent role'),
    Permission('perm_agent', PERM.AGENT_PERM_ROLE_UPDATE, 'Update an Agent role'),
    Permission('perm_agent', PERM.AGENT_PERM_ROLE_DELETE, 'Delete an Agent role'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_CREATE_MANY, 'Create Teams and Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_GET_MANY, 'Read Teams and Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_UPDATE_MANY, 'Update Teams and Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_TEAM_DELETE_MANY, 'Delete Teams and Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_LIST, 'List Agents'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_GET, 'Read an Agent'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_CREATE, 'Create an Agent'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_UPDATE, 'Update an Agent'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_DELETE, 'Delete an Agent'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_CREATE_MANY, 'Create Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_GET_MANY, 'Read Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_UPDATE_MANY, 'Update Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_AGENT_DELETE_MANY, 'Delete Agents in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_LIST, 'List Agent sessions'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_GET, 'Read an Agent session'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_CREATE, 'Create an Agent session'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_CREATE_MANY, 'Create Agent sessions in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_UPDATE, 'Update an Agent session'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_DELETE, 'Delete an Agent session'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_GET_MANY, 'Read Agent sessions in bulk'),
    Permission('perm_agent', PERM.AGENT_PERM_SESSION_DELETE_MANY, 'Delete Agent sessions in bulk'),
];

export const PERMS_BY_FAMILY = {};
for (const p of PERMS) {
    if (!PERMS_BY_FAMILY[p.family]) PERMS_BY_FAMILY[p.family] = [p];
    else PERMS_BY_FAMILY[p.family].push(p);
}

// people whose rank is less than 1% will get Level 10
export const LEVELS = [100, 90, 70, 55, 40, 30, 20, 10, 5, 2, 1];

export const BUILTIN_ROLES = {
    guest: PERM.USER_PERM_BASIC,
    default: PERM.USER_PERM_DEFAULT,
    root: PERM.USER_PERM_ALL,
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