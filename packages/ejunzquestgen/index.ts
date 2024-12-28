import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter, DomainModel, ProblemModel,ProblemDoc,
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

    static async get(
        domainId: string,
        qid: string | number,
        projection: Projection<QuestionDoc> = QuestionModel.PROJECTION_PUBLIC,
        rawConfig = false
    ): Promise<QuestionDoc | null> { // 确保返回类型是 QuestionDoc
        if (Number.isSafeInteger(+qid)) qid = +qid;
        const res = typeof qid === 'number'
            ? await document.get(domainId, TYPE_QUESTION, qid, projection)
            : (await document.getMulti(domainId, TYPE_QUESTION, { sort: sortable(qid), qid })
                .project(buildProjection(projection)).limit(1).toArray())[0];
        if (!res) return null;
        return res as QuestionDoc; // 强制类型转换为 QuestionDoc
    }
    

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
        docId: ObjectId,
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
            options,
            answer,
            difficulty: meta.difficulty || 1,
            reference: meta.reference || null,
            createdAt: new Date(), // 添加创建时间
            updatedAt: null,       // 初始化更新时间为 null
    
        };
    
        if (qid) args.qid = qid;
        if (meta.difficulty) args.difficulty = meta.difficulty;
        if (meta.reference) args.reference = meta.reference;
    
        const result = await document.add(domainId, content, owner, TYPE_QUESTION, docId, null, null, args);
        return result;
    }
    static async list(
        domainId: string, 
        query: Filter<QuestionDoc>, 
        page: number, 
        pageSize: number, 
        projection = QuestionModel.PROJECTION_PUBLIC
    ): Promise<[QuestionDoc[], number, number]> {
        // 获取相关 domain ID，包括 union 的扩展域
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union.union || [])];
    
        let count = 0; // 总计数
        const qdocs: QuestionDoc[] = []; // 存储查询结果
    
        for (const id of domainIds) {
            // 获取指定域中符合条件的文档总数
            // eslint-disable-next-line no-await-in-loop
            const ccount = await document.count(id, TYPE_QUESTION, query);
    
            // 根据分页参数处理结果
            if (qdocs.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                // eslint-disable-next-line no-await-in-loop
                qdocs.push(
                    ...(await document
                        .getMulti(id, TYPE_QUESTION, query, projection)
                        .sort({ sort: 1, docId: 1 }) // 按 sort 和 docId 排序
                        .skip(Math.max((page - 1) * pageSize - count, 0))
                        .limit(pageSize - qdocs.length)
                        .toArray())
                );
            }
    
            count += ccount; // 累加当前域的计数
        }
    
        // 返回查询结果、总页数和总计数
        return [qdocs, Math.ceil(count / pageSize), count];
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

                let generatedQid = question.qid || '';
                if (!generatedQid) {
                    generatedQid = await this.generateUniqueQid(domainId);
                } else {
              
                    const existingQuestion = await QuestionModel.get(domainId, generatedQid);
                    if (existingQuestion) {
                        throw new Error(`QID "${generatedQid}" already exists in domain "${domainId}".`);
                    }
                }

                const questionDoc: Partial<QuestionDoc> = {
                    docType: 91,
                    domainId,
                    qid: generatedQid, 
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
                        ? { label: answerOption.label, value: answerOption.value } 
                        : null,
                    hidden: question.hidden || false,
                    sort: question.sort || `P${newDocId}`, 
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


    async generateUniqueQid(domainId: string): Promise<string> {
        let qid: string;
        let isUnique = false;

        while (!isUnique) {

            qid = `Q${Math.random().toString(36).substring(2, 10).toUpperCase()}`; 

            const existingQuestion = await QuestionModel.get(domainId, qid);
            if (!existingQuestion) {
                isUnique = true; 
            }
        }

        return qid;
    }
}


export class StagingQuestionHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';
        console.log('Resolved domainId in GET:', domainId);

        const query = {}; // 添加筛选条件
        const projection = QuestionModel.PROJECTION_PUBLIC;

        try {
            // 调用 QuestionModel.list 获取分页数据
            const [questions, totalPages, totalCount] = await QuestionModel.list(domainId, query, page, pageSize, projection);

            console.log(`Fetched ${questions.length} questions for domainId: ${domainId}`);

            this.response.template = 'staging_questions.html';
            this.response.body = {
                questions,
                domainId,
                page,
                pageSize,
                totalPages,
                totalCount,
            };
        } catch (error) {
            console.error('Error while fetching questions:', error.message);
            this.response.template = 'error.html';
            this.response.body = {
                error: 'Failed to fetch questions.',
            };
        }
    }

    async post() {
        console.log('POST /questgen/stage_publish reached');
        
        const selectedQuestions = this.request.body.selectedQuestions;
        if (!selectedQuestions || !Array.isArray(selectedQuestions) || selectedQuestions.length === 0) {
            this.response.status = 400;
            this.response.body = { error: 'No questions selected for publishing.' };
            return;
        }
    

        try {
            for (const questionId of selectedQuestions) {
                // 根据 questionId 获取问题数据并创建新问题
                const question = await QuestionModel.get(this.context.domainId, questionId);
                if (!question) continue;

                const problemContent = this.generateProblemContent(question);
                await ProblemModel.add(
                    this.context.domainId,
                    `P${new ObjectId()}`, // 生成新的问题 ID
                    question.title,
                    problemContent,
                    this.user._id,
                    question.tag || [],
                    { difficulty: question.difficulty, hidden: false }
                );
            }

            this.response.status = 200;
            this.response.body = { message: 'Selected questions have been published successfully.' };
        } catch (error) {
            console.error('Error while publishing questions:', error.message);
            this.response.status = 500;
            this.response.body = { error: 'Failed to publish questions.' };
        }
    }
    generateProblemContent(question: QuestionDoc): string {
        let content = `# Title\n${question.title}\n\n`;
    
        content += `# Description\n${question.content}\n\n`;
    
        content += `# Options\n`;
        for (const option of question.options) {
            content += `- **${option.label}**: ${option.value}\n`;
        }

        content += `\n# Answer\nThe correct answer is **${question.answer}**.\n`;
    
        return content;
    }
    
}
    


export async function apply(ctx: Context) {
    ctx.Route('generator_detail', '/questgen', QuestionHandler, PRIV.PRIV_USER_PROFILE );
    ctx.Route('generator_main', '/questgen/mcq', Question_MCQ_Handler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('staging_push', '/questgen/stage_push', StagingPushHandler, PRIV.PRIV_USER_PROFILE); 
    ctx.Route('staging_questions', '/questgen/stage_list', StagingQuestionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('staging_questions_publish', '/questgen/stage_publish', StagingQuestionHandler, PRIV.PRIV_USER_PROFILE); // 新增
    
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
