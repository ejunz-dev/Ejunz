import { omit } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { DiscussionNodeNotFoundError, DocumentNotFoundError } from '../error';
import {
    HubHistoryDoc, HubReplyDoc, HubTailReplyDoc, Document
} from '../interface';
import * as bus from '../service/bus';
import db from '../service/db';
import { NumberKeys } from '../typeutils';
import { buildProjection } from '../utils';
import { PERM } from './builtin';
import * as contest from './contest';
import * as document from './document';
import problem from './problem';
import * as training from './training';
import { User } from './user';
import DocsModel from './doc';
import storage from '../model/storage';
import { pick } from 'lodash';
import { Readable } from 'stream';
import { ArrayKeys } from '../typeutils';

export class FileModel {
    
    static async addCommentFile(
        domainId: string, drid: ObjectId, name: string,
        f: Readable | Buffer | string, operator = 1, skipUpload = false,
    ) {
        name = name.trim();
        const [[, HubFileInfo]] = await Promise.all([
            document.getSub(domainId, document.TYPE_HUB_REPLY, drid, 'commentfile', name),
            skipUpload ? '' : storage.put(`hub/${domainId}/${drid}/commentfile/${name}`, f, operator),
        ]);
        const meta = await storage.getMeta(`hub/${domainId}/${drid}/commentfile/${name}`);
        const payload = { name, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!HubFileInfo) await this.push(domainId, drid, 'commentfile', { _id: name, ...payload });
        else await document.setSub(domainId, document.TYPE_HUB_REPLY, drid, 'commentfile', name, payload);
        
    }

    static async addReplyFile(
        domainId: string, drrid: ObjectId, name: string,
        f: Readable | Buffer | string, operator = 1, skipUpload = false,
    ) {
        name = name.trim();
        const [[, Hubfileinfo]] = await Promise.all([
            document.getSub(domainId, document.TYPE_HUB_REPLY, drrid, 'replyfile', name),
            skipUpload ? '' : storage.put(`hub/${domainId}/${drrid}/replyfile/${name}`, f, operator),
        ]);
        const meta = await storage.getMeta(`hub/${domainId}/${drrid}/replyfile/${name}`);
        const payload = { name, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!Hubfileinfo) await this.push(domainId, drrid, 'replyfile', { _id: name, ...payload });
        else await document.setSub(domainId, document.TYPE_HUB_REPLY, drrid, 'replyfile', name, payload);
        
    }

    static push<T extends ArrayKeys<HubTailReplyDoc>>(domainId: string, _id: ObjectId, key: ArrayKeys<HubTailReplyDoc>, value: HubTailReplyDoc[T][0]) {
        return document.push(domainId, document.TYPE_HUB_REPLY, _id, key, value);
    }
}
global.Ejunz.model.file = FileModel;
export default FileModel;
