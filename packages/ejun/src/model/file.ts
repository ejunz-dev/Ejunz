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
    
static async addAdditionalFile(
    domainId: string, did: ObjectId, name: string,
    f: Readable | Buffer | string, operator = 1, skipUpload = false,
) {
    name = name.trim();
    const [[, fileinfo]] = await Promise.all([
        document.getSub(domainId, document.TYPE_HUB_REPLY, did, 'additional_file', name),
        skipUpload ? '' : storage.put(`hub/${domainId}/${did}/additional_file/${name}`, f, operator),
    ]);
    const meta = await storage.getMeta(`hub/${domainId}/${did}/additional_file/${name}`);
    const payload = { name, ...pick(meta, ['size', 'lastModified', 'etag']) };
    if (!fileinfo) await this.push(domainId, did, 'additional_file', { _id: name, ...payload });
    else await document.setSub(domainId, document.TYPE_HUB_REPLY, did, 'additional_file', name, payload);
    await bus.emit('hub/addAdditionalFile', domainId, did, name, payload);
}

static push<T extends ArrayKeys<HubReplyDoc>>(domainId: string, did: ObjectId, key: ArrayKeys<HubReplyDoc>, value: HubReplyDoc[T][0]) {
    return document.push(domainId, document.TYPE_HUB_REPLY, did, key, value);
}
}
global.Ejunz.model.file = FileModel;
export default FileModel;
