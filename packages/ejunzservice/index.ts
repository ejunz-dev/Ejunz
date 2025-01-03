import { Context, ApiMixin } from 'ejun';
import { QuestionDoc } from '@ejunz/ejunzquestgen';

declare module 'ejun' {
    export interface Events<C extends Context = Context> {
        'question/generated': (domainId: string, questionDocId: string, questionDoc: Partial<QuestionDoc>) => void;
        'library/updated': (domainId: string, libraryId: string, updateData: { questionId: number }) => void;
    }
}

export async function apply(ctx: Context) {
    const api = new ApiMixin(ctx);

    // 动态注册 `question/generated` 事件
    api.registerEvent('question/generated', (domainId: string, questionDocId: string, questionDoc: any) => {
        console.log(`Question generated: ${domainId}, ID: ${questionDocId}`);
    });

    // 动态注册 `library/updated` 事件
    api.registerEvent('library/updated', (domainId: string, libraryId: string, updateData: any) => {
        console.log(`Library updated: ${domainId}, ID: ${libraryId}`);
    });
}


