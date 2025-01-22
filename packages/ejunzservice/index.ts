import { Context, ApiMixin, ObjectId, Logger,docs } from 'ejun';
import { QuestionDoc } from '@ejunz/ejunzquestgen';

const logger = new Logger('addon/bus');


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
    

    // 动态注册 `docs/updated` 事件
    api.registerEvent('docs/updated', (domainId: string, docsId: string, updateData: any) => {
        console.log(`Docs updated: ${domainId}, ID: ${docsId}`);
    });
}


