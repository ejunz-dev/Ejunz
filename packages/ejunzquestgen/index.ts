import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate, post, query, route,
    param, PRIV, Types, UserModel, PERM, PERMS_BY_FAMILY, Permission, BadRequestError, PermissionError, NotFoundError
} from 'ejun';
import * as document from 'ejun/src/model/document';
import fs from 'fs';
import path from 'path';
import { Logger } from '@ejunz/utils/lib/utils';

function sortable(source: string) {
    return source.replace(/(\d+)/g, (str) => (str.length >= 6 ? str : ('0'.repeat(6 - str.length) + str)));
}

const logger = new Logger('question');

export function buildProjection<T extends keyof QuestionDoc>(fields: readonly T[]): Projection<QuestionDoc> {
    const o: Partial<Projection<QuestionDoc>> = {};
    for (const k of fields) o[k] = true;
    return o as Projection<QuestionDoc>;
}

export const TYPE_QUESTION: 91 = 91;

export interface QuestionDoc {
    _id: ObjectId;
    docType: 91;
    domainId: string;
    qid: string;
    docId: ObjectId;
    title: string;
    tag: string[];
    owner: number;
    content: string;
    options: { label: string; value: string }[];
    answer: { label: string; value: string } | null;
    hidden?: boolean;
    sort?: string;
    difficulty?: number;
    reference?: {
        domainId: string;
        qid: number;
    };
    createdAt: Date;
    updatedAt?: Date;
}

declare module 'ejun' {
    interface Model {
        question: typeof QuestionModel;
    }
    interface DocType {
        [TYPE_QUESTION]: QuestionDoc;
    }
}

interface QuestionCreateOptions {
    difficulty?: number;
    hidden?: boolean;
    reference?: { domainId: string, qid: number };
}

export class QuestionModel {
    static PROJECTION_PUBLIC: (keyof QuestionDoc)[] = [
        '_id', 'domainId', 'docType', 'docId', 'qid', 'owner', 'title', 'tag', 'content', 'options', 'answer', 'difficulty', 'createdAt', 'updatedAt',
    ];

    static async getMulti(
        domainId: string,
        filter: Record<string, any>,
        projection: (keyof QuestionDoc)[]
    ) {
        return await DocumentModel.getMulti(domainId, 91, filter, projection);
    }

    static async add(
        domainId: string, qid: string = '', title: string, content: string, owner: number,
        tag: string[] = [], options: { label: string; value: string }[] = [], answer: string = '',
        meta: QuestionCreateOptions = {},
    ) {
        const newDocId = new ObjectId();
        const result = await QuestionModel.addWithId(
            domainId, newDocId.toHexString(), qid, title, content, owner, tag, options, answer, meta
        );
        return result;
    }

    static async addWithId(
        domainId: string,
        docId: string,
        qid: string = '',
        title: string,
        content: string,
        owner: number,
        tag: string[] = [],
        options: { label: string; value: string }[] = [],
        answer: { label: string; value: string } | null = null, 
        meta: QuestionCreateOptions = {},
    ) {
        const args: Partial<QuestionDoc> = {
            title,
            tag,
            hidden: meta.hidden || false,
            sort: sortable(qid || `P${docId}`),
            options, // 直接传递 options 数组
            answer,  // 直接传递 answer 字段
        };
    
        if (qid) args.qid = qid;
        if (meta.difficulty) args.difficulty = meta.difficulty;
        if (meta.reference) args.reference = meta.reference;
    
        const result = await document.add(domainId, content, owner, TYPE_QUESTION, docId, null, null, args);
        return result;
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
        const domainId = this.args?.domainId || this.context?.domainId || 'system';

        console.log('Resolved domainId in GET:', domainId);

        this.context.domainId = domainId;

        this.response.template = 'generator_main.html';
        this.response.body = {
            message: 'Welcome to the Question Generator!',
            questions: null,
            domainId,
            userId: this.user?._id || null,
        };
    }

    async post() {
        let domainId = this.args?.domainId || this.context?.domainId || this.request.body?.domainId;

        if (!domainId && this.request.headers.referer) {
            const match = this.request.headers.referer.match(/\/d\/([^/]+)/);
            domainId = match ? match[1] : 'system';
        }

        console.log('Resolved domainId in POST:', domainId);

        const userId = this.user?._id || null;

        const { input_text, max_questions, question_type, difficulty } = this.request.body;
        const params = {
            domainId,
            userId,
            input_text,
            max_questions: parseInt(max_questions, 10),
            question_type,
            difficulty,
        };

        console.log('POST Parameters:', params);

        try {
            const apiUrl = loadApiConfig();
            const response = await fetch(`${apiUrl}/generate-mcq`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                throw new Error(`API call failed with status: ${response.status}`);
            }

            const data = await response.json();
            console.log('API Response:', JSON.stringify(data, null, 2));

            this.response.template = 'generator_main.html';
            this.response.body = {
                questions: data.questions,
                message: 'Questions generated successfully!',
            };
        } catch (error) {
            console.error('Error while generating questions:', error.message);

            this.response.template = 'generator_main.html';
            this.response.body = { error: `Failed to generate questions: ${error.message}` };
        }
    }
}

export class StagingPushHandler extends Handler {
    async post() {
        const domainId = this.context.domainId;
        const payload = this.request.body.questions_payload;

        if (!payload) {
            console.error('No questions payload provided.');
            this.response.status = 400;
            this.response.body = { error: 'No questions payload provided.' };
            return;
        }

        try {
            const questions: any[] = typeof payload === 'string' ? JSON.parse(payload) : payload;

            const savedIds: ObjectId[] = [];
            for (const question of questions) {
                if (!question.question_statement || !Array.isArray(question.labeled_options) || !question.answer) {
                    throw new Error('Invalid question format: Each question must include question_statement, labeled_options, and answer.');
                }

                const newDocId = new ObjectId();
                const answerOption = question.labeled_options.find((option: any) => option.value === question.answer);

                const questionDoc: Partial<QuestionDoc> = {
                    docType: 91,
                    domainId,
                    qid: question.qid || '',
                    docId: newDocId.toHexString(),
                    title: question.title || question.question_statement,
                    tag: question.tag || [],
                    owner: this.user._id,
                    content: question.question_statement,
                    options: question.labeled_options.map((option: any) => ({
                        label: option.label,
                        value: option.value,
                    })),
                    answer: answerOption
                    ? { label: answerOption.label, value: answerOption.value } // 包含完整答案信息
                    : null,
                    hidden: question.hidden || false,
                    sort: question.sort || null,
                    difficulty: question.difficulty || 1,
                    reference: question.reference || null,
                    createdAt: new Date(),
                    updatedAt: null,
                };
                console.log('Constructed QuestionDoc:', questionDoc);
                

                const stagedId = await QuestionModel.addWithId(
                    domainId,
                    questionDoc.docId!,
                    questionDoc.qid || '',
                    questionDoc.title,
                    questionDoc.content,
                    questionDoc.owner,
                    questionDoc.tag,
                    questionDoc.options || [],
                    questionDoc.answer || '',
                    {
                        difficulty: questionDoc.difficulty,
                        hidden: questionDoc.hidden,
                        reference: questionDoc.reference,
                    }
                );

                savedIds.push(newDocId);
            }

            this.response.status = 200;
            this.response.template = 'generator_main.html';
            this.response.body = {
                message: 'Questions pushed successfully!',
                savedIds,
            };
        } catch (error) {
            console.error('Error while pushing questions:', error.message);
            this.response.status = 500;
            this.response.template = 'generator_main.html';
            this.response.body = {
                error: `Failed to push questions: ${error.message}`,
            };
        }
    }
}

export class StagingQuestionHandler extends Handler {
    async get({ domainId, page = 1, ppcount = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';
        console.log('Resolved domainId in GET:', domainId);

        const filter = {};
        const projection = QuestionModel.PROJECTION_PUBLIC;

        try {
            const skip = (page - 1) * ppcount;

            const cursor = await QuestionModel.getMulti(domainId, filter, projection);
            const questions = await cursor.skip(skip).limit(ppcount).toArray();
            const totalCount = await cursor.clone().count();

            console.log(`Fetched ${questions.length} questions for domainId: ${domainId}`);

            this.response.template = 'staging_questions.html';
            this.response.body = {
                questions,
                domainId,
                page,
                ppcount,
                totalCount,
            };
        } catch (error) {
            console.error('Error while fetching questions:', error.message);
            this.response.template = 'error.html';
            this.response.body = {
                error: 'Failed to fetch staged questions.',
            };
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('generator_detail', '/questgen', QuestionHandler, PRIV.PRIV_USER_PROFILE );
    ctx.Route('generator_main', '/questgen/mcq', Question_MCQ_Handler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('staging_push', '/questgen/stage_push', StagingPushHandler, PRIV.PRIV_USER_PROFILE); 
    ctx.Route('staging_questions', '/questgen/stage_list', StagingQuestionHandler, PRIV.PRIV_USER_PROFILE);

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
