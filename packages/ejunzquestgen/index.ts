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

class QuestionHandler extends Handler {
    async get() {
        this.response.template = 'generator_detail.html';
        this.response.body = {
            message: 'Welcome to the Question Generator!',
        };
    }
}


class Question_MCQ_Handler extends Handler {
    async get() {
        this.response.template = 'generator_main.html'; 
        this.response.body = {
            message: 'Welcome to the Question Generator!',
            questions: null, 
        };
    }

    async post() {
        const input_text = this.request.body.input_text?.trim();
        const max_questions = parseInt(this.request.body.max_questions, 10);

        if (!input_text || isNaN(max_questions) || max_questions <= 0) {
            this.response.template = 'generator_main.html';
            this.response.body = {
                error: 'Invalid input. Please provide valid input text and a positive number for max questions.',
                message: 'Welcome to the Question Generator!',
                questions: null, 
            };
            return;
        }

        const apiUrl = loadApiConfig();
        const params = { input_text, max_questions };

        try {
            const response = await fetch(`${apiUrl}/generate-mcq`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                throw new Error(`API call failed with status: ${response.status}`);
            }

            const data = await response.json();

            this.response.template = 'generator_main.html';
            this.response.body = {
                questions: data.questions || [],
                message: 'Questions generated successfully!',
            };
        } catch (error) {
            // 错误处理
            this.response.template = 'generator_main.html';
            this.response.body = {
                error: `Failed to generate questions: ${error.message}`,
                message: 'Welcome to the Question Generator!',
                questions: null,
            };
        }
    }
}


export async function apply(ctx: Context) {
    ctx.Route('generator_detail', '/questgen', QuestionHandler, PRIV.PRIV_USER_PROFILE )
    ctx.Route('generator_main', '/questgen/mcq', Question_MCQ_Handler, PRIV.PRIV_USER_PROFILE);
   

    ctx.injectUI('UserDropdown', 'generator_detail', (handler) => ({
        icon: 'create',
        displayName: 'Question Generator',
        uid: handler.user._id.toString(),
    }), PRIV.PRIV_USER_PROFILE);

    ctx.injectUI('Nav', 'generator_detail', () => ({
        name: 'generator_detail',
        displayName: 'Generator',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));

    ctx.i18n.load('zh', {
        question: '生成器',
        generator_detail: '生成器',
        'Question Generator': '生成器',
        'Welcome to the MCQ Question Generator!': '欢迎使用选择题生成器！',
        'Input Text': '输入文本',
        'Max Questions': '最多问题',
        'Generated Questions': '生成的问题',
        'Submit': '提交',
        'Invalid input. Please provide valid input text and a positive number for max questions.': '输入无效，请提供有效的输入文本和正数的问题数量。',
    });

    ctx.i18n.load('en', {
        question: 'Generator',
        generator_detail: 'Generator',
        'Question Generator': 'Generator',
        'Welcome to the Question Generator!': 'Welcome to the Question Generator!',
        'Input Text': 'Input Text',
        'Max Questions': 'Max Questions',
        'Generated Questions': 'Generated Questions',
        'Submit': 'Submit',
        'Invalid input. Please provide valid input text and a positive number for max questions.': 'Invalid input. Please provide valid input text and a positive number for max questions.',
    });
}
