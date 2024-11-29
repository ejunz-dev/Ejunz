import { Context, Handler, PRIV, param, Types } from 'ejun';
import fs from 'fs';
import path from 'path';

function loadApiConfig() {
    const configPath = path.resolve(require('os').homedir(), '.ejunz', 'apiConfig.json');

    if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found at ${configPath}. Please create it.`);
    }

    try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configContent);

        if (!config.apiUrl) {
            throw new Error('API URL is missing in the configuration file.');
        }

        return config.apiUrl;
    } catch (error) {
        throw new Error(`Failed to load configuration file: ${error.message}`);
    }
}

class GeneratorHandler extends Handler {
    async get() {
        this.response.template = 'generator_main.html';
        this.response.body = {
            message: 'Welcome to the Question Generator!',
        };
    }
}

class GeneratorGenerateHandler extends Handler {
    @param('text', Types.String, true) 
    @param('count', Types.PositiveInt, true) 
    async post(domainId: string, text: string, count: number) {
        const apiUrl = loadApiConfig(); 
        const params = { text, count };

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                throw new Error('API call failed');
            }

            const data = await response.json();

            this.response.body = { result: data.result };
        } catch (error) {
            this.response.body = { error: 'Failed to generate question.' };
        }
    }
}

export async function apply(ctx: Context) {
    // 注册路由
    ctx.Route('generator_main', '/generator', GeneratorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('generator_generate', '/generator/generate', GeneratorGenerateHandler, PRIV.PRIV_USER_PROFILE);

    ctx.injectUI('UserDropdown', 'generator_main', (handler) => ({
        icon: 'create',
        displayName: 'Question Generator',
        uid: handler.user._id.toString(),
    }), PRIV.PRIV_USER_PROFILE);

    ctx.injectUI('Nav', 'generator_main', () => ({
        name: 'generator_main',
        displayName: 'Generator',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));

    // 多语言支持
    ctx.i18n.load('zh', {
        generator: '生成器',
        generator_main: '生成器',
        'Question Generator': "生成器",
        'Welcome to the Question Generator!': '欢迎使用题目生成器！',
        'Submit': '提交',
        'Text': '文本',
        'Count': '数量',
        'Generated Question': '生成的题目',
    });

    ctx.i18n.load('en', {
        generator: 'Generator',
        generator_main: 'Generator',
        'Welcome to the Question Generator!': 'Welcome to the Question Generator!',
        'Submit': 'Submit',
        'Text': 'Text',
        'Count': 'Count',
        'Generated Question': 'Generated Question',
    });
}
