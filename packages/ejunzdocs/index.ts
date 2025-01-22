import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,PERM,
    param, PRIV, Types, UserModel, DomainModel,StorageModel,ProblemModel,NotFoundError
} from 'ejun';

export const TYPE_DOCS: 100 = 100;
export interface DocsDoc {
    docType: 100;
    docId: ObjectId;
    domainId: string,
    lid: number;
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    nReply: number;
    views: number;
    reply: any[];
    react: Record<string, number>;
}
declare module 'ejun' {
    interface Model {
        docs: typeof DocsModel;
    }
    interface DocType {
        [TYPE_DOCS]: DocsDoc;
    }
}

