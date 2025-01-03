import { Context, ApiMixin, ObjectId, Logger } from 'ejun';
import { QuestionDoc } from '@ejunz/ejunzquestgen';
import {LibraryModel} from '@ejunz/ejunzlibrary';

const logger = new Logger('addon/bus');


declare module 'ejun' {
    export interface Events<C extends Context = Context> {
        'question/generated': (domainId: string, questionDocId: string, questionDoc: Partial<QuestionDoc>) => void;
        'library/updated': (domainId: string, libraryId: string, updateData: { questionId: number }) => void;
    }
}

export async function apply(ctx: Context) {
    const api = new ApiMixin(ctx);

    // 动态注册并监听 `question/published` 事件
    api.registerEvent('question/published', async (payload) => {
        logger.info('[Event Triggered] question/published:', payload);

        // 测试日志
        if (payload?.associatedDocumentId) {
            logger.info(
                `Published question associated with document ID: ${payload.associatedDocumentId}`
            );
        }
    });
    

    // 动态注册 `library/updated` 事件
    api.registerEvent('library/updated', (domainId: string, libraryId: string, updateData: any) => {
        console.log(`Library updated: ${domainId}, ID: ${libraryId}`);
    });
}


