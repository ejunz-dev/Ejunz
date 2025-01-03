import { Context, ApiMixin, ObjectId } from 'ejun';
import { QuestionDoc } from '@ejunz/ejunzquestgen';
import {LibraryModel} from '@ejunz/ejunzlibrary';

declare module 'ejun' {
    export interface Events<C extends Context = Context> {
        'question/generated': (domainId: string, questionDocId: string, questionDoc: Partial<QuestionDoc>) => void;
        'library/updated': (domainId: string, libraryId: string, updateData: { questionId: number }) => void;
    }
}

export async function apply(ctx: Context) {
    const api = new ApiMixin(ctx);

    // 动态注册 `question/generated` 事件
    api.registerEvent('question/generated', async (domainId, questionDocId, questionDoc, selectedDocumentId) => {
        if (selectedDocumentId) {
            const libraryDoc = await LibraryModel.get(domainId, new ObjectId(selectedDocumentId));
            const updatedContent = `${libraryDoc.content}\nAssociated question: ${questionDocId}`;
            await LibraryModel.edit(domainId, selectedDocumentId, libraryDoc.title, updatedContent);
            console.log(`[Library Updated] Linked question ID ${questionDocId} to library ID ${selectedDocumentId}`);
        } else {
            console.log(`[Event Triggered] No document selected for linking question ID ${questionDocId}`);
        }
    });
    

    // 动态注册 `library/updated` 事件
    api.registerEvent('library/updated', (domainId: string, libraryId: string, updateData: any) => {
        console.log(`Library updated: ${domainId}, ID: ${libraryId}`);
    });
}


