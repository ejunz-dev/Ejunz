import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, PERM, PERMS_BY_FAMILY, Permission
} from 'ejun';
import fs from 'fs';
import path from 'path';
import { serializer } from '@ejunz/framework';

declare module 'ejun' {
    interface DocType {
        [TYPE_QUESTION]: QuestionDoc;
    }
}

export interface QuestionDoc {
    docType: 91;
    docId: ObjectId;
    owner: number;
    question_statement: string;
    options: { label: string; value: string }[];
    correct_answer: string;
    createdAt: Date;
}

export const TYPE_QUESTION: 91 = 91;

export class QuestionModel {
    static async add(
        owner: number,
        question_statement: string,
        options: { label: string; value: string }[],
        correct_answer: string
    ): Promise<ObjectId> {
        const payload: Partial<QuestionDoc> = {
            owner,
            question_statement,
            options,
            correct_answer,
            createdAt: new Date(),
        };

        // 将问题数据保存到数据库
        const result = await DocumentModel.add(
            'system',
            JSON.stringify(payload), // 保存完整问题数据为字符串
            payload.owner!,
            TYPE_QUESTION, // 自定义的题目类型
            null,
            null,
            null,
            payload
        );

        return result;
    }

    static async getAll(owner: number): Promise<QuestionDoc[]> {
        return DocumentModel.getMulti('system', TYPE_QUESTION, { owner }).toArray();
    }
}


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
            console.log('Sending request to API:', JSON.stringify(params, null, 2)); // 打印发送的请求
    
            const response = await fetch(`${apiUrl}/generate-mcq`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });
    
            if (!response.ok) {
                console.error(`API call failed with status: ${response.status}`);
                throw new Error(`API call failed with status: ${response.status}`);
            }
    
            const data = await response.json();
            console.log('API Response:', JSON.stringify(data, null, 2)); // 打印完整响应
    
            if (!data.questions || !Array.isArray(data.questions)) {
                throw new Error('Invalid response format from the API.');
            }
    
            console.log('Rendered Questions JSON:', JSON.stringify(data.questions, null, 2)); // 打印问题的 JSON
    
            this.response.template = 'generator_main.html';
            this.response.body = {
                questions: data.questions,
                message: 'Questions generated successfully!',
            };
        } catch (error) {
            console.error('Error while generating questions:', error.message);
    
            this.response.template = 'generator_main.html';
            this.response.body = {
                error: `Failed to generate questions: ${error.message}`,
                message: 'Welcome to the Question Generator!',
                questions: null,
            };
        }
    }
    
}

class StagingPushHandler extends Handler {
    async post() {
        console.log('POST /staging/push triggered');

        let payload = this.request.body.questions_payload;

        if (!payload) {
            console.error('No questions payload provided.');
            this.response.status = 400;
            this.response.body = { error: 'No questions payload provided.' };
            return;
        }

        console.log('Received payload:', payload);

        try {
            // 尝试解析 JSON
            let questions;
            if (typeof payload === 'string') {
                // 安全替换并解析
                try {
                    questions = JSON.parse(payload.replace(/'/g, '"'));
                } catch (parseError) {
                    console.error('Invalid JSON format:', parseError.message);
                    throw new Error('Payload contains invalid JSON.');
                }
            } else {
                questions = payload;
            }

            console.log('Parsed questions:', questions);

            const savedIds = [];
            for (const question of questions) {
                if (!question.question_statement || !question.labeled_options || !question.answer) {
                    console.error('Invalid question format:', question);
                    throw new Error(
                        'Invalid question format: Each question must include question_statement, labeled_options, and answer.'
                    );
                }

                // 保存问题到数据库
                const stagedId = await QuestionModel.add(
                    this.user._id,
                    question.question_statement,
                    question.labeled_options,
                    question.answer
                );
                savedIds.push(stagedId);
            }

            console.log('Saved IDs:', savedIds);

            this.response.status = 200;
            this.response.body = { message: 'Questions pushed successfully.', savedIds };
        } catch (error) {
            console.error('Error while pushing questions:', error.message);
            this.response.status = 500;
            this.response.body = { error: `Failed to push questions: ${error.message}` };
        }
    }
}






export async function apply(ctx: Context) {
    ctx.Route('generator_detail', '/questgen', QuestionHandler, PRIV.PRIV_USER_PROFILE )
    ctx.Route('generator_main', '/questgen/mcq', Question_MCQ_Handler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('staging_push', '/staging/push', StagingPushHandler); // 不指定权限


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
