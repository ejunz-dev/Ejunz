import {
    getScoreColor, STATUS, STATUS_CODES, STATUS_SHORT_TEXTS,
    STATUS_TEXTS, USER_GENDER_FEMALE, USER_GENDER_ICONS, USER_GENDER_MALE,
    USER_GENDER_OTHER, USER_GENDER_RANGE, USER_GENDERS, 
} from '@ejunz/utils/lib/status';
import {
   Logger
} from '@ejunz/utils/lib/utils';

export * from '@ejunz/utils/lib/status';

const logger = new Logger('addon/PERM');


export const PERM = {
    PERM_NONE: 0n,

    // Domain Settings
    PERM_VIEW: 1n << 0n,
    PERM_EDIT_DOMAIN: 1n << 1n,
    PERM_VIEW_DISPLAYNAME: 1n << 67n,
    PERM_MOD_BADGE: 1n << 2n,

    // Problem
    PERM_CREATE_PROBLEM: 1n << 4n,
    PERM_EDIT_PROBLEM: 1n << 5n,
    PERM_EDIT_PROBLEM_SELF: 1n << 6n,
    PERM_VIEW_PROBLEM: 1n << 7n,
    PERM_VIEW_PROBLEM_HIDDEN: 1n << 8n,
    PERM_SUBMIT_PROBLEM: 1n << 9n,
    PERM_READ_PROBLEM_DATA: 1n << 10n,

    // Record
    PERM_VIEW_RECORD: 1n << 70n,
    PERM_READ_RECORD_CODE: 1n << 12n,
    PERM_READ_RECORD_CODE_ACCEPT: 1n << 66n,
    PERM_REJUDGE_PROBLEM: 1n << 13n,
    PERM_REJUDGE: 1n << 14n,

    // Problem Solution
    PERM_VIEW_PROBLEM_SOLUTION: 1n << 15n,
    PERM_VIEW_PROBLEM_SOLUTION_ACCEPT: 1n << 65n,
    PERM_CREATE_PROBLEM_SOLUTION: 1n << 16n,
    PERM_VOTE_PROBLEM_SOLUTION: 1n << 17n,
    PERM_EDIT_PROBLEM_SOLUTION: 1n << 18n,
    PERM_EDIT_PROBLEM_SOLUTION_SELF: 1n << 19n,
    PERM_DELETE_PROBLEM_SOLUTION: 1n << 20n,
    PERM_DELETE_PROBLEM_SOLUTION_SELF: 1n << 21n,
    PERM_REPLY_PROBLEM_SOLUTION: 1n << 22n,
    PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF: 1n << 24n,
    PERM_DELETE_PROBLEM_SOLUTION_REPLY: 1n << 25n,
    PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF: 1n << 26n,

    // Discussion
    PERM_VIEW_DISCUSSION: 1n << 27n,
    PERM_CREATE_DISCUSSION: 1n << 28n,
    PERM_HIGHLIGHT_DISCUSSION: 1n << 29n,
    PERM_PIN_DISCUSSION: 1n << 61n,
    PERM_EDIT_DISCUSSION: 1n << 30n,
    PERM_EDIT_DISCUSSION_SELF: 1n << 31n,
    PERM_DELETE_DISCUSSION: 1n << 32n,
    PERM_DELETE_DISCUSSION_SELF: 1n << 33n,
    PERM_REPLY_DISCUSSION: 1n << 34n,
    PERM_ADD_REACTION: 1n << 62n,
    PERM_EDIT_DISCUSSION_REPLY_SELF: 1n << 36n,
    PERM_DELETE_DISCUSSION_REPLY: 1n << 38n,
    PERM_DELETE_DISCUSSION_REPLY_SELF: 1n << 39n,
    PERM_DELETE_DISCUSSION_REPLY_SELF_DISCUSSION: 1n << 40n,
    PERM_LOCK_DISCUSSION: 1n << 64n,

    // Hub
    PERM_VIEW_HUB: 1n << 27n,
    PERM_CREATE_HUB: 1n << 28n,
    PERM_HIGHLIGHT_HUB: 1n << 29n,
    PERM_PIN_HUB: 1n << 61n,
    PERM_EDIT_HUB: 1n << 30n,
    PERM_EDIT_HUB_SELF: 1n << 31n,
    PERM_DELETE_HUB: 1n << 32n,
    PERM_DELETE_HUB_SELF: 1n << 33n,
    PERM_REPLY_HUB: 1n << 34n,
    PERM_EDIT_HUB_REPLY_SELF: 1n << 36n,
    PERM_DELETE_HUB_REPLY: 1n << 38n,
    PERM_DELETE_HUB_REPLY_SELF: 1n << 39n,
    PERM_DELETE_HUB_REPLY_SELF_HUB: 1n << 40n,
    PERM_LOCK_HUB: 1n << 64n,
    PERM_UPLOAD_HUB_REPLY: 1n << 41n,

    // Contest
    PERM_VIEW_CONTEST: 1n << 41n,
    PERM_VIEW_CONTEST_SCOREBOARD: 1n << 42n,
    PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: 1n << 43n,
    PERM_CREATE_CONTEST: 1n << 44n,
    PERM_ATTEND_CONTEST: 1n << 45n,
    PERM_EDIT_CONTEST: 1n << 50n,
    PERM_EDIT_CONTEST_SELF: 1n << 51n,
    PERM_VIEW_HIDDEN_CONTEST: 1n << 68n,

    // Homework
    PERM_VIEW_HOMEWORK: 1n << 52n,
    PERM_VIEW_HOMEWORK_SCOREBOARD: 1n << 53n,
    PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD: 1n << 54n,
    PERM_CREATE_HOMEWORK: 1n << 55n,
    PERM_ATTEND_HOMEWORK: 1n << 56n,
    PERM_EDIT_HOMEWORK: 1n << 57n,
    PERM_EDIT_HOMEWORK_SELF: 1n << 58n,
    PERM_VIEW_HIDDEN_HOMEWORK: 1n << 69n,

    // Training
    PERM_VIEW_TRAINING: 1n << 46n,
    PERM_CREATE_TRAINING: 1n << 47n,
    PERM_EDIT_TRAINING: 1n << 48n,
    PERM_PIN_TRAINING: 1n << 63n,
    PERM_EDIT_TRAINING_SELF: 1n << 49n,

    // Ranking
    PERM_VIEW_RANKING: 1n << 59n,

    // Placeholder
    PERM_ALL: -1n,
    PERM_BASIC: 0n,
    PERM_DEFAULT: 0n,
    PERM_ADMIN: -1n,

    PERM_NEVER: 1n << 60n,
};


export const Permission = (family: string, key: BigInt, desc: string) => ({ family, key, desc });

export const PERMS = [
    Permission('perm_general', PERM.PERM_VIEW, 'View this domain'),
    Permission('perm_general', PERM.PERM_VIEW_DISPLAYNAME, 'View domain user displayname'),
    Permission('perm_general', PERM.PERM_EDIT_DOMAIN, 'Edit domain settings'),
    Permission('perm_general', PERM.PERM_MOD_BADGE, 'Show MOD badge'),
    Permission('perm_problem', PERM.PERM_CREATE_PROBLEM, 'Create problems'),
    Permission('perm_problem', PERM.PERM_EDIT_PROBLEM, 'Edit problems'),
    Permission('perm_problem', PERM.PERM_EDIT_PROBLEM_SELF, 'Edit own problems'),
    Permission('perm_problem', PERM.PERM_VIEW_PROBLEM, 'View problems'),
    Permission('perm_problem', PERM.PERM_VIEW_PROBLEM_HIDDEN, 'View hidden problems'),
    Permission('perm_problem', PERM.PERM_SUBMIT_PROBLEM, 'Submit problem'),
    Permission('perm_problem', PERM.PERM_READ_PROBLEM_DATA, 'Read data of problem'),
    Permission('perm_record', PERM.PERM_VIEW_RECORD, "View other's records"),
    Permission('perm_record', PERM.PERM_READ_RECORD_CODE, 'Read all record codes'),
    Permission('perm_record', PERM.PERM_READ_RECORD_CODE_ACCEPT, 'Read record codes after accept'),
    Permission('perm_record', PERM.PERM_REJUDGE_PROBLEM, 'Rejudge problems'),
    Permission('perm_record', PERM.PERM_REJUDGE, 'Rejudge records'),
    Permission('perm_problem_solution', PERM.PERM_VIEW_PROBLEM_SOLUTION, 'View problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT, 'View problem solutions after accept'),
    Permission('perm_problem_solution', PERM.PERM_CREATE_PROBLEM_SOLUTION, 'Create problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_VOTE_PROBLEM_SOLUTION, 'Vote problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_EDIT_PROBLEM_SOLUTION, 'Edit problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_EDIT_PROBLEM_SOLUTION_SELF, 'Edit own problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_DELETE_PROBLEM_SOLUTION, 'Delete problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_DELETE_PROBLEM_SOLUTION_SELF, 'Delete own problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_REPLY_PROBLEM_SOLUTION, 'Reply problem solutions'),
    Permission('perm_problem_solution', PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF, 'Edit own problem solution replies'),
    Permission('perm_problem_solution', PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY, 'Delete problem solution replies'),
    Permission('perm_problem_solution', PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF, 'Delete own problem solution replies'),
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
    Permission('perm_contest', PERM.PERM_VIEW_CONTEST, 'View contests'),
    Permission('perm_contest', PERM.PERM_VIEW_CONTEST_SCOREBOARD, 'View contest scoreboard'),
    Permission('perm_contest', PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD, 'View hidden contest submission status and scoreboard'),
    Permission('perm_contest', PERM.PERM_CREATE_CONTEST, 'Create contests'),
    Permission('perm_contest', PERM.PERM_ATTEND_CONTEST, 'Attend contests'),
    Permission('perm_contest', PERM.PERM_EDIT_CONTEST, 'Edit any contests'),
    Permission('perm_contest', PERM.PERM_EDIT_CONTEST_SELF, 'Edit own contests'),
    Permission('perm_contest', PERM.PERM_VIEW_HIDDEN_CONTEST, 'View all contests'),
    Permission('perm_homework', PERM.PERM_VIEW_HOMEWORK, 'View homework'),
    Permission('perm_homework', PERM.PERM_VIEW_HOMEWORK_SCOREBOARD, 'View homework scoreboard'),
    Permission('perm_homework', PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD, 'View hidden homework submission status and scoreboard'),
    Permission('perm_homework', PERM.PERM_CREATE_HOMEWORK, 'Create homework'),
    Permission('perm_homework', PERM.PERM_ATTEND_HOMEWORK, 'Claim homework'),
    Permission('perm_homework', PERM.PERM_EDIT_HOMEWORK, 'Edit any homework'),
    Permission('perm_homework', PERM.PERM_EDIT_HOMEWORK_SELF, 'Edit own homework'),
    Permission('perm_homework', PERM.PERM_VIEW_HIDDEN_HOMEWORK, 'View all homework'),
    Permission('perm_training', PERM.PERM_VIEW_TRAINING, 'View training plans'),
    Permission('perm_training', PERM.PERM_CREATE_TRAINING, 'Create training plans'),
    Permission('perm_training', PERM.PERM_EDIT_TRAINING, 'Edit training plans'),
    Permission('perm_training', PERM.PERM_PIN_TRAINING, 'Pin training plans'),
    Permission('perm_training', PERM.PERM_EDIT_TRAINING_SELF, 'Edit own training plans'),
    Permission('perm_ranking', PERM.PERM_VIEW_RANKING, 'View ranking'),
];

export const PERMS_BY_FAMILY = {};
for (const p of PERMS) {
    if (!PERMS_BY_FAMILY[p.family]) PERMS_BY_FAMILY[p.family] = [p];
    else PERMS_BY_FAMILY[p.family].push(p);
}

PERM.PERM_BASIC = PERM.PERM_VIEW
    | PERM.PERM_VIEW_PROBLEM
    | PERM.PERM_VIEW_PROBLEM_SOLUTION
    | PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT
    | PERM.PERM_VIEW_DISCUSSION
    | PERM.PERM_VIEW_CONTEST
    | PERM.PERM_VIEW_CONTEST_SCOREBOARD
    | PERM.PERM_VIEW_HOMEWORK
    | PERM.PERM_VIEW_HOMEWORK_SCOREBOARD
    | PERM.PERM_VIEW_TRAINING
    | PERM.PERM_VIEW_RANKING
    | PERM.PERM_VIEW_RECORD;

PERM.PERM_DEFAULT = PERM.PERM_VIEW
    | PERM.PERM_VIEW_DISPLAYNAME
    | PERM.PERM_VIEW_PROBLEM
    | PERM.PERM_EDIT_PROBLEM_SELF
    | PERM.PERM_SUBMIT_PROBLEM
    | PERM.PERM_VIEW_PROBLEM_SOLUTION
    | PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT
    | PERM.PERM_CREATE_PROBLEM_SOLUTION
    | PERM.PERM_VOTE_PROBLEM_SOLUTION
    | PERM.PERM_EDIT_PROBLEM_SOLUTION_SELF
    | PERM.PERM_DELETE_PROBLEM_SOLUTION_SELF
    | PERM.PERM_REPLY_PROBLEM_SOLUTION
    | PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF
    | PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF
    | PERM.PERM_VIEW_DISCUSSION
    | PERM.PERM_CREATE_DISCUSSION
    | PERM.PERM_EDIT_DISCUSSION_SELF
    | PERM.PERM_REPLY_DISCUSSION
    | PERM.PERM_ADD_REACTION
    | PERM.PERM_EDIT_DISCUSSION_REPLY_SELF
    | PERM.PERM_DELETE_DISCUSSION_REPLY_SELF
    | PERM.PERM_DELETE_DISCUSSION_REPLY_SELF_DISCUSSION
    | PERM.PERM_VIEW_CONTEST
    | PERM.PERM_VIEW_CONTEST_SCOREBOARD
    | PERM.PERM_ATTEND_CONTEST
    | PERM.PERM_EDIT_CONTEST_SELF
    | PERM.PERM_VIEW_HOMEWORK
    | PERM.PERM_VIEW_HOMEWORK_SCOREBOARD
    | PERM.PERM_ATTEND_HOMEWORK
    | PERM.PERM_EDIT_HOMEWORK_SELF
    | PERM.PERM_VIEW_TRAINING
    | PERM.PERM_CREATE_TRAINING
    | PERM.PERM_EDIT_TRAINING_SELF
    | PERM.PERM_SUBMIT_PROBLEM
    | PERM.PERM_CREATE_PROBLEM_SOLUTION
    | PERM.PERM_VOTE_PROBLEM_SOLUTION
    | PERM.PERM_REPLY_PROBLEM_SOLUTION
    | PERM.PERM_CREATE_DISCUSSION
    | PERM.PERM_REPLY_DISCUSSION
    | PERM.PERM_ATTEND_CONTEST
    | PERM.PERM_CREATE_TRAINING
    | PERM.PERM_ATTEND_HOMEWORK
    | PERM.PERM_VIEW_RANKING
    | PERM.PERM_VIEW_RECORD;

PERM.PERM_ADMIN = PERM.PERM_ALL;

export const PRIV = {
    PRIV_NONE: 0,
    PRIV_MOD_BADGE: 1 << 25,
    PRIV_EDIT_SYSTEM: 1 << 0, // renamed from PRIV_SET_PRIV
    PRIV_SET_PERM: 1 << 1,
    PRIV_USER_PROFILE: 1 << 2,
    PRIV_REGISTER_USER: 1 << 3,
    PRIV_READ_PROBLEM_DATA: 1 << 4,
    PRIV_READ_RECORD_CODE: 1 << 7,
    PRIV_VIEW_HIDDEN_RECORD: 1 << 8,
    PRIV_JUDGE: 1 << 9, // (renamed)
    PRIV_CREATE_DOMAIN: 1 << 10,
    PRIV_VIEW_ALL_DOMAIN: 1 << 11,
    PRIV_MANAGE_ALL_DOMAIN: 1 << 12,
    PRIV_REJUDGE: 1 << 13,
    PRIV_VIEW_USER_SECRET: 1 << 14,
    PRIV_VIEW_JUDGE_STATISTICS: 1 << 15,
    PRIV_UNLIMITED_ACCESS: 1 << 22,
    PRIV_VIEW_SYSTEM_NOTIFICATION: 1 << 23,
    PRIV_SEND_MESSAGE: 1 << 24,
    PRIV_CREATE_FILE: 1 << 16,
    PRIV_UNLIMITED_QUOTA: 1 << 17,
    PRIV_DELETE_FILE: 1 << 18,

    PRIV_ALL: -1,
    PRIV_DEFAULT: 0,
    PRIV_NEVER: 1 << 20,
};

PRIV.PRIV_DEFAULT = PRIV.PRIV_USER_PROFILE
    + PRIV.PRIV_CREATE_FILE
    + PRIV.PRIV_SEND_MESSAGE;

// people whose rank is less than 1% will get Level 10
export const LEVELS = [100, 90, 70, 55, 40, 30, 20, 10, 5, 2, 1];

export const BUILTIN_ROLES = {
    guest: PERM.PERM_BASIC,
    default: PERM.PERM_DEFAULT,
    root: PERM.PERM_ALL,
};

export const DEFAULT_NODES = {
    团队空间: [
        { pic: 'team', name: 'Game' },
        { pic: 'team', name: 'Sport' },
        { pic: 'team', name: 'Project' },
    ],
    Ejunz: [
        { pic: 'ejunz', name: 'Ejunz' },
        { pic: 'ejunz', name: 'domains' },
    ],
    知识库: [
        { pic: 'knowledge', name: 'Skills' },
        { pic: 'knowledge', name: 'Subject' },
        { pic: 'knowledge', name: 'Book' },
    ],
    建议: [
        { pic: 'suggestion', name: 'Suggestion' },
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


// 初始化全局对象
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
    USER_GENDER_MALE,
    USER_GENDER_FEMALE,
    USER_GENDER_OTHER,
    USER_GENDERS,
    USER_GENDER_RANGE,
    USER_GENDER_ICONS,
};
