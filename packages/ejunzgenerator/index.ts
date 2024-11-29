import { _, Context, Handler, PRIV } from 'ejun';

class GeneratorHandler extends Handler {
    async get() {
        this.response.template = 'generator_main.html'; 
        this.response.body = {
            message: 'Welcome to the Question Generator!',
        };
    }
}

class GeneratorCreateHandler extends Handler {
    async get() {
        this.response.template = 'generator_create.html'; 
        this.response.body = {
            message: 'Create a new Question Generator task.',
        };
    }
}

class GeneratorDetailHandler extends Handler {
    async get(domainId: string, did: string) {
        this.response.template = 'generator_detail.html'; /
        this.response.body = {
            message: `Viewing details for generator ID: ${did}`,
        };
    }
}

// 插件应用逻辑
export async function apply(ctx: Context) {
    // 定义路由
    ctx.Route('generator_main', '/generator', GeneratorHandler, PRIV.PRIV_USER_PROFILE); 
    ctx.Route('generator_create', '/generator/create', GeneratorCreateHandler, PRIV.PRIV_USER_PROFILE); 
    ctx.Route('generator_detail', '/generator/:did', GeneratorDetailHandler, PRIV.PRIV_USER_PROFILE); 
    ctx.injectUI('UserDropdown', 'generator_main', (handler) => ({
        icon: 'create', // 图标
        displayName: 'Question Generator', // 显示名称
        uid: handler.user._id.toString(),
    }), PRIV.PRIV_USER_PROFILE);

    // 注入到导航栏
    ctx.injectUI('Nav', 'generator_main', () => ({
        name: 'generator_main',
        displayName: 'Generator',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));

    ctx.i18n.load('zh', {
        generator: '生成器',
        generator_main: '生成器',
        generator_detail: '生成器详情',
        generator_create: '创建生成器',
        'Welcome to the Question Generator!': '欢迎使用题目生成器！',
        'Create a new Question Generator task.': '创建新的题目生成任务。',
        'Details for the generator task will appear here.': '生成任务的详细信息将显示在此处。',
        'Submit': '提交',
        'Title': '标题',
        'Description': '描述',
        'Create New Task': '创建新任务',
    });
    
    ctx.i18n.load('zh_TW', {
        generator: '生成器',
        generator_main: '生成器',
        generator_detail: '生成器詳情',
        generator_create: '創建生成器',
        'Welcome to the Question Generator!': '歡迎使用題目生成器！',
        'Create a new Question Generator task.': '創建新的題目生成任務。',
        'Details for the generator task will appear here.': '生成任務的詳細信息將顯示在此處。',
        'Submit': '提交',
        'Title': '標題',
        'Description': '描述',
        'Create New Task': '創建新任務',
    });
    
    ctx.i18n.load('kr', {
        generator: '생성기',
        generator_main: '생성기',
        generator_detail: '생성기 세부 정보',
        generator_create: '생성기 생성',
        'Welcome to the Question Generator!': '질문 생성기에 오신 것을 환영합니다!',
        'Create a new Question Generator task.': '새 질문 생성 작업을 생성합니다.',
        'Details for the generator task will appear here.': '생성 작업의 세부 정보가 여기에 표시됩니다.',
        'Submit': '제출',
        'Title': '제목',
        'Description': '설명',
        'Create New Task': '새 작업 생성',
    });
    
    ctx.i18n.load('en', {
        generator: 'Generator',
        generator_main: 'Generator',
        generator_detail: 'Generator Detail',
        generator_create: 'Create Generator',
        'Welcome to the Question Generator!': 'Welcome to the Question Generator!',
        'Create a new Question Generator task.': 'Create a new Question Generator task.',
        'Details for the generator task will appear here.': 'Details for the generator task will appear here.',
        'Submit': 'Submit',
        'Title': 'Title',
        'Description': 'Description',
        'Create New Task': 'Create New Task',
    });
    
}
