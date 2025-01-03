import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter, DomainModel, ProblemModel, ProblemDoc, bus,
    Handler, NumberKeys, ObjectId, OplogModel, paginate, post, query, route, Projection, buildProjection,
    param, PRIV, Types, UserModel, PERM, PERMS_BY_FAMILY, Permission, BadRequestError, PermissionError, NotFoundError
} from 'ejun';
import * as document from 'ejun/src/model/document';
import fs from 'fs';
import path from 'path';
import { Logger } from '@ejunz/utils/lib/utils';
import {LibraryModel} from '@ejunz/ejunzlibrary';

function sortable(source: string) {
    return source.replace(/(\d+)/g, (str) => (str.length >= 6 ? str : ('0'.repeat(6 - str.length) + str)));
}

const logger = new Logger('question');

export type Field = keyof QuestionDoc;

export const TYPE_QUESTION: 91 = 91;

export interface QuestionDoc {
    _id: ObjectId;
    docType: 91;
    domainId: string;
    qid: string;
    docId: number;
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
    static PROJECTION_PUBLIC: Field[] = [
        '_id', 'domainId', 'docType', 'docId', 'qid', 'owner', 'title', 'tag', 'content', 'options', 'answer', 'difficulty', 'createdAt', 'updatedAt',
    ];
    static PROJECTION_CONTEST_LIST: Field[] = [
        '_id', 'domainId', 'docType', 'docId', 'qid',
        'owner', 'title', 'content', 'options', 'answer'
    ];
    static PROJECTION_LIST: Field[] = [
        ...QuestionModel.PROJECTION_CONTEST_LIST,
        'content', 'options', 'answer'
    ];
    static async get(
        domainId: string,
        qid: string | number,
        projection: Projection<QuestionDoc> = QuestionModel.PROJECTION_PUBLIC,
        rawConfig = false
    ): Promise<QuestionDoc | null> {
        if (Number.isSafeInteger(+qid)) qid = +qid;
        const res = typeof qid === 'number'
            ? await document.get(domainId, TYPE_QUESTION, qid, projection)
            : (await document.getMulti(domainId, TYPE_QUESTION, { sort: sortable(qid), qid })
                .project(buildProjection(projection)).limit(1).toArray())[0];
        if (!res) return null;
        return res as QuestionDoc;
    }
    static getMulti(domainId: string, query: Filter<QuestionDoc>, projection = QuestionModel.PROJECTION_LIST) {
        return document.getMulti(domainId, TYPE_QUESTION, query, projection).sort({ sort: 1 });
    }
    static async generateNextDocId(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, 91, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (lastDoc[0]?.docId || 0) + 1;
    }
    static async add(
        domainId: string,
        qid: string = '',
        title: string,
        content: string,
        owner: number,
        tag: string[] = [],
        options: { label: string; value: string }[] = [],
        answer: { label: string; value: string } | null,
        meta: QuestionCreateOptions = {},
    ) {
        const docId = await QuestionModel.generateNextDocId(domainId);
        const result = await QuestionModel.addWithId(
            domainId, docId, qid, title, content, owner, tag, options, answer, meta
        );
        return result;
    }
    static async addWithId(
        domainId: string,
        docId: number,
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
            createdAt: new Date(),
            updatedAt: null,
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
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union.union || [])];
        let count = 0;
        const qdocs: QuestionDoc[] = [];
        for (const id of domainIds) {
            const ccount = await document.count(id, TYPE_QUESTION, query);
            if (qdocs.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                qdocs.push(
                    ...(await document
                        .getMulti(id, TYPE_QUESTION, query, projection)
                        .sort({ sort: 1, docId: 1 })
                        .skip(Math.max((page - 1) * pageSize - count, 0))
                        .limit(pageSize - qdocs.length)
                        .toArray())
                );
            }
            count += ccount;
        }
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
        this.context.domainId = domainId;

        const documents = await LibraryModel.getMulti(domainId, {}).project({ _id: 1, title: 1, content: 1 }).toArray();

        this.response.template = 'generator_main.html';
        this.response.body = {
            message: 'Welcome to the Question Generator!',
            questions: null, 
            documents, 
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
        const userId = this.user?._id || null;

        const {
            input_text,
            max_questions,
            question_type,
            difficulty,
            selectedDocumentId: selected_document_id,
        } = this.request.body;

        const params = {
            domainId,
            userId,
            input_text,
            max_questions: parseInt(max_questions, 10),
            question_type,
            difficulty,
            selected_document_id,
        };

        console.log(`Received params: ${JSON.stringify(this.request.body)}`);
        console.log(`Selected Document ID (selectedDocumentId): ${selected_document_id}`);

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

            console.log(`Received data: ${JSON.stringify(data)}`);
            this.context.selected_document_id = data.selected_document_id;


            
            this.response.template = 'generator_main.html';
            this.response.body = {
                questions: data.questions,
                message: 'Questions generated successfully!',
                domainId,
                selected_document_id: data.selected_document_id,
                documents: await LibraryModel.getMulti(domainId, {}).project({ _id: 1, title: 1, content: 1 }).toArray(),
            };
        } catch (error) {
            console.error(`Error in generating questions: ${error.message}`);
            this.response.template = 'generator_main.html';
            this.response.body = {
                error: `Failed to generate questions: ${error.message}`,
                domainId,
                documents: await LibraryModel.getMulti(domainId, {}).project({ _id: 1, title: 1, content: 1 }).toArray(),
            };
        }
    }
}


export class StagingPushHandler extends Handler {
    async post() {
        const domainId = this.context.domainId;
        const payload = this.request.body.questions_payload;
        const selectedDocumentId = this.request.body.selected_document_id; // 从前端获取

        console.log(`Received selected_document_id from frontend: ${selectedDocumentId}`);

        if (!payload) {
            this.response.status = 400;
            this.response.body = { error: 'No questions payload provided.' };
            return;
        }

        try {
            const questions = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const savedIds = [];

            for (const question of questions) {
                if (!question.question_statement || !Array.isArray(question.labeled_options) || !question.answer) {
                    throw new Error('Invalid question format: Each question must include question_statement, labeled_options, and answer.');
                }

                const newDocId = await this.generateNextDocId(domainId);

                const questionDoc = {
                    docType: 91,
                    domainId,
                    docId: newDocId,
                    content: question.question_statement,
                    options: question.labeled_options.map(option => ({
                        label: option.label,
                        value: option.value,
                    })),
                    answer: { label: 'Example Label', value: question.answer },
                };

                console.log(`[Event Trigger] Triggering 'question/generated' for domainId: ${domainId}, docId: ${newDocId}`);
                await bus.parallel('question/generated', domainId, newDocId, questionDoc, selectedDocumentId);
                console.log(`[Event Triggered] 'question/generated' triggered successfully for docId: ${newDocId}`);
                savedIds.push(newDocId);
            }

            this.response.status = 200;
            this.response.body = {
                message: 'Questions pushed and events triggered successfully!',
                savedIds,
            };
        } catch (error) {
            console.error('Error during processing:', error.message);
            this.response.status = 500;
            this.response.body = {
                error: `Failed to process request: ${error.message}`,
            };
        }
    }
 
    async generateNextDocId(domainId: string): Promise<number> {
        const [lastDoc] = await QuestionModel.getMulti(domainId, {}, ['docId'])
            .sort({ docId: -1 })
            .limit(1)
            .toArray();
        return (lastDoc?.docId || 0) + 1;
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
        const query = {};
        const projection = QuestionModel.PROJECTION_PUBLIC;
        try {
            const [questions, totalPages, totalCount] = await QuestionModel.list(domainId, query, page, pageSize, projection);
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
            this.response.template = 'error.html';
            this.response.body = {
                error: 'Failed to fetch questions.',
            };
        }
    }
    private generateProblemContent(question: QuestionDoc): string {
        let content = `# Title\n${question.title}\n\n`;
        content += `# Description\n${question.content}\n\n`;
        content += `# Options\n`;
        for (const option of question.options) {
            content += `- **${option.label}**: ${option.value}\n`;
        }
        content += `\n# Answer\nThe correct answer is **${question.answer?.label || 'N/A'}**.\n`;
        return content;
    }
    @param('docIds', Types.NumericArray)
    async post(domainId: string, docIds: number[]) {
        if (!docIds || docIds.length === 0) {
            this.response.status = 400;
            this.response.body = { error: 'No questions selected for publishing.' };
            return;
        }
        let successCount = 0;
        let failedCount = 0;
        for (const docId of docIds) {
            try {
                const questionDoc = await QuestionModel.get(domainId, docId);
                if (!questionDoc) {
                    failedCount++;
                    continue;
                }
                if (!this.user.own(questionDoc, PERM.PERM_EDIT_PROBLEM_SELF)) {
                    this.checkPerm(PERM.PERM_EDIT_PROBLEM);
                }
                const problemContent = this.generateProblemContent(questionDoc);
                await ProblemModel.add(
                    domainId,
                    `P${docId}`,
                    questionDoc.title,
                    problemContent,
                    this.user._id,
                    questionDoc.tag || [], 
                    questionDoc.options || [], 
                    questionDoc.answer || null, 
                    {
                        difficulty: questionDoc.difficulty || 1,
                        hidden: questionDoc.hidden || false,
                    }
                );
                
                successCount++;
            } catch (error) {
                failedCount++;
            }
        }
        this.response.body = {
            message: `Successfully published ${successCount} questions.`,
            total: docIds.length,
            success: successCount,
            failed: failedCount,
        };
        this.response.status = successCount > 0 ? 200 : 400;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('generator_detail', '/questgen', QuestionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('generator_main', '/questgen/mcq', Question_MCQ_Handler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('staging_push', '/questgen/stage_push', StagingPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('staging_questions', '/questgen/stage_list', StagingQuestionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('staging_questions_publish', '/questgen/stage_publish', StagingQuestionHandler, PRIV.PRIV_USER_PROFILE);
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
