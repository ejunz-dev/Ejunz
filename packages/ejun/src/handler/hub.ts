import { isSafeInteger } from 'lodash';
import { ObjectId } from 'mongodb';
import {
    DiscussionLockedError, DiscussionNodeNotFoundError, DiscussionNotFoundError, DocumentNotFoundError,
    PermissionError,ValidationError,NotFoundError
} from '../error';
import { HubDoc, HubReplyDoc, HubTailReplyDoc } from '../interface';
import { PERM, PRIV } from '../model/builtin';
import * as discussion from '../model/discussion';
import * as document from '../model/document';
import message from '../model/message';
import * as oplog from '../model/oplog';
import user from '../model/user';
import { Handler, param, Types,post} from '../service/server';
import storage from '../model/storage';
import * as Hub from '../model/hub';
import { lookup } from 'mime-types';
import { encodeRFC5987ValueChars } from '../service/storage';
import AdmZip from 'adm-zip';
import sanitize from 'sanitize-filename';
import { statSync } from 'fs';
import { FileLimitExceededError } from '../error';
import * as HubModel from '../model/hub';
import * as FileModel from '../model/file';

export const typeMapper = {
    problem: document.TYPE_PROBLEM,
    contest: document.TYPE_CONTEST,
    node: document.TYPE_HUB_NODE,
    training: document.TYPE_TRAINING,
    homework: document.TYPE_CONTEST,
    docs: document.TYPE_DOCS,
};

class DiscussionHandler extends Handler {
    ddoc?: HubDoc;
    drdoc?: HubReplyDoc;
    drrdoc?: HubTailReplyDoc;
    vnode?: any;

    @param('type', Types.Range(Object.keys(typeMapper)), true)
    @param('name', Types.String, true)
    @param('did', Types.ObjectId, true)
    @param('drid', Types.ObjectId, true)
    @param('drrid', Types.ObjectId, true)
    async _prepare(
        domainId: string, type: string, name: string,
        did: ObjectId, drid: ObjectId, drrid: ObjectId,
    ) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        if (did) {
            this.ddoc = await discussion.get(domainId, did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
            type = discussion.typeDisplay[this.ddoc.parentType];
            name = this.ddoc.parentId.toString();
            if (drrid) {
                [this.drdoc, this.drrdoc] = await discussion.getTailReply(domainId, drid, drrid);
                if (!this.drrdoc) throw new DiscussionNotFoundError(domainId, drrid);
            } else if (drid) {
                this.drdoc = await discussion.getReply(domainId, drid);
                if (!this.drdoc) throw new DiscussionNotFoundError(domainId, drid);
                if (!this.drdoc.parentId.equals(this.ddoc._id)) {
                    throw new DocumentNotFoundError(domainId, drid);
                }
            }
        }
        // TODO(twd2): exclude problem/contest discussions?
        // TODO(iceboy): continuation based pagination.
        this.vnode = await discussion.getVnode(domainId, typeMapper[type], name, this.user._id);
        if (!discussion.checkVNodeVisibility(typeMapper[type], this.vnode, this.user)) throw new DiscussionNodeNotFoundError(this.vnode.id);
        if (this.ddoc) {
            this.ddoc.parentType ||= this.vnode.type;
            this.ddoc.parentId ||= this.vnode.id;
        }
    }
}

class DiscussionMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('all', Types.Boolean)
    async get(domainId: string, page = 1, all = false) {
        console.log('Resolved domainId:', domainId);
    console.log('Request headers:', this.request.headers);
    console.log('Request query:', this.request.query);
    console.log('Context domain:', this.context.EjunzContext.domain);

        // Limit to known types
        const parentType = { $in: Object.keys(typeMapper).map((i) => typeMapper[i]) };
        all &&= this.user.hasPerm(PERM.PERM_MOD_BADGE);
        const [ddocs, dpcount] = await this.paginate(
            discussion.getMulti(domainId, { parentType, ...all ? {} : { hidden: false } }),
            page,
            'discussion',
        );
        const udict = await user.getList(domainId, ddocs.map((ddoc) => ddoc.owner));
        const [vndict, vnodes] = await Promise.all([
            discussion.getListVnodes(domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group),
            discussion.getNodes(domainId),
        ]);

        this.response.template = 'hub_main_or_node.html';
        this.response.body = {
            ddocs, dpcount, udict, page, page_name: 'hub_main', vndict, vnode: {}, vnodes,
        };
        
    }
}

class DiscussionNodeHandler extends DiscussionHandler {
    @param('type', Types.Range(Object.keys(typeMapper)))
    @param('name', Types.String)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, type: string, _name: string, page = 1) {
        let name: ObjectId | string | number;
        if (ObjectId.isValid(_name)) name = new ObjectId(_name);
        else if (isSafeInteger(parseInt(_name, 10))) name = parseInt(_name, 10);
        else name = _name;
        const hidden = this.user.own(this.vnode) || this.user.hasPerm(PERM.PERM_EDIT_DISCUSSION) ? {} : { hidden: false };
        const [ddocs, dpcount] = await this.paginate(
            discussion.getMulti(domainId, { parentType: typeMapper[type], parentId: name, ...hidden }),
            page,
            'discussion',
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(this.vnode.owner);
        const [udict, vnodes] = await Promise.all([
            user.getList(domainId, uids),
            discussion.getNodes(domainId),
        ]);
        const vndict = { [typeMapper[type]]: { [name.toString()]: this.vnode } };
        this.response.template = 'hub_main_or_node.html';
        this.response.body = {
            ddocs,
            dpcount,
            udict,
            page,
            vndict,
            vnode: this.vnode,
            page_name: 'hub_node',
            vnodes,
        };
        console.log('response',this.response.body)
    }
}

class DiscussionCreateHandler extends DiscussionHandler {
    async get({ type, name }) {
        // 强制转换 name 为数字
        const resolvedName = typeof name === 'string' ? parseInt(name, 10) : name;
        if (isNaN(resolvedName)) {
            throw new Error(`Invalid name (lid): ${name}`);
        }

        console.log('Resolved name (lid):', resolvedName, 'Type:', typeof resolvedName);

        const path = [
            ['Ejunz', 'homepage'],
            ['hub_main', 'hub_main'],
            [this.vnode.title, 'hub_node', { type, name: resolvedName }, true],
            ['hub_create', null],
        ];

        this.response.template = 'hub_create.html';
        this.response.body = { path, vnode: this.vnode };
        console.log('ddoc:', this.ddoc);
console.log('vnode:', this.vnode);
    }

    @param('type', Types.Range(Object.keys(typeMapper)))
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async post(
        domainId: string, type: string, title: string,
        content: string, highlight = false, pin = false,
    ) {
        await this.limitRate('add_discussion', 3600, 60);

        if (highlight) this.checkPerm(PERM.PERM_HIGHLIGHT_DISCUSSION);
        if (pin) this.checkPerm(PERM.PERM_PIN_DISCUSSION);

        // 确保 vnode.id 是数字
        let resolvedId = this.vnode.id;
        if (typeof resolvedId === 'string') {
            resolvedId = parseInt(resolvedId, 10);
        }
        if (isNaN(resolvedId)) {
            throw new Error(`Invalid vnode.id: ${this.vnode.id}`);
        }

        console.log('Resolved vnode.id:', resolvedId, 'Type:', typeof resolvedId);

        const hidden = this.vnode.hidden ?? false;
        const did = await discussion.add(
            domainId, typeMapper[type], resolvedId, this.user._id,
            title, content, this.request.ip, highlight, pin, hidden,
        );

        this.response.body = { did };
        this.response.redirect = this.url('hub_detail', { did });

console.log('vnode:', this.vnode);


    }
}
class HUBFSDownloadHandler extends Handler {
    noCheckPermView = true;

    async get({did, filename }: { did: string, filename: string }) {
        const domainId = this.args?.domainId || this.context?.domainId || 'default_domain';
        console.log('Resolved params:', { domainId, filename });

        console.log("Entering DomainFSDownloadHandler.get...");
        console.log("Received domainId:", domainId, "filename:", filename);


        const target = `hub/${domainId}/${did}/${filename}`;
        const file = await storage.getMeta(target);
        if (!file) {
            throw new NotFoundError(`File "${filename}" does not exist.`);
        }
        console.log("Generated target path:", target);

        const mimeType = lookup(filename) || 'application/octet-stream';
        console.log("File MIME type:", mimeType);

        try {
            this.response.body = await storage.get(target);
            this.response.type = mimeType;

            if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
                this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
            }
        } catch (e) {
            throw new Error(`Error streaming file "${filename}": ${e.message}`);
        }

        console.log("File streamed successfully:", file);
    }
}

class DiscussionDetailHandler extends DiscussionHandler {
    @param('did', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, did: ObjectId, page = 1) {
        console.log('Context:', this.context);
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await discussion.getStatus(domainId, did, this.user._id)
            : null;
        const [drdocs, pcount, drcount] = await this.paginate(
            Hub.getMultiReplyWiFile(domainId, did),
            page,
            'reply',
        );
        const uids = [
            ...this.vnode.owner ? [this.vnode.owner] : [],
            this.ddoc.owner,
            ...drdocs.map((drdoc) => drdoc.owner),
        ];
        for (const drdoc of drdocs) {
            if (drdoc.reply) uids.push(...drdoc.reply.map((drrdoc) => drrdoc.owner));
        }
        const reactions = { [did.toHexString()]: dsdoc?.react || {} };
        await Promise.all(drdocs.map((drdoc) =>
            discussion.getReaction(domainId, document.TYPE_DISCUSSION_REPLY, drdoc._id, this.user._id).then((reaction) => {
                reactions[drdoc._id.toHexString()] = reaction;
            })));
        const udict = await user.getList(domainId, uids);
        if (!dsdoc?.view && this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            await Promise.all([
                discussion.inc(domainId, did, 'views', 1),
                discussion.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        const path = [
            ['Ejunz', 'homepage'],
            ['hub_main', 'hub_main'],
            [this.vnode.title, 'hub_node', { type: discussion.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, null, null, true],
        ];
        const urlForFile = (filename: string) =>
            this.url('domain_fs_download', { domainId, filename });
        
        this.response.template = 'hub_detail.html';
        this.response.body = {
            path, ddoc: this.ddoc, dsdoc, drdocs, page, pcount, drcount, udict, vnode: this.vnode, reactions, urlForFile,
        };
        console.log('urlForFile',urlForFile)
    }


    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectId)
    @param('lock', Types.Boolean)
    async postSetLock(domainId: string, did: ObjectId, lock: boolean) {
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_LOCK_DISCUSSION);
        await discussion.edit(domainId, did, { lock });
        this.back();
    }

    @param('nodeType', Types.Range(['did', 'drid']))
    @param('id', Types.ObjectId)
    @param('emoji', Types.Emoji)
    @param('reverse', Types.Boolean)
    async postReaction(domainId: string, type: string, did: ObjectId, id: string, reverse = false) {
        this.checkPerm(PERM.PERM_ADD_REACTION);
        const docType = type === 'did' ? document.TYPE_DISCUSSION : document.TYPE_DISCUSSION_REPLY;
        const [doc, sdoc] = await discussion.react(domainId, docType, did, id, this.user._id, reverse);
        this.response.body = { doc, sdoc };
        this.back();
    }

    @param('did', Types.ObjectId)
    @param('content', Types.Content)
    @param('filename', Types.String)
    async postReply(domainId: string, did: ObjectId, content: string, filename: string) {
        console.log('Received filename:', filename); // 调试输出

        this.checkPerm(PERM.PERM_REPLY_DISCUSSION);
        if (this.ddoc.lock) throw new DiscussionLockedError(domainId, did);
        await this.limitRate('add_discussion', 3600, 60);

        if (!filename || typeof filename !== 'string') {
            throw new ValidationError('Filename is required and must be a string.');
        }

         const file = this.request.files?.file;
        if (!file) {
            throw new ValidationError('A file must be uploaded to create a repo.');
        }
    

        const filePath = `hub/${domainId}/${did}/${filename}`;
        await storage.put(filePath, file.filepath, this.user._id);
        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) {
            throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);
        }

        const fileData = {
            filename: filename,
            path: filePath,
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };

        const drid = await Hub.addWithFile(
            domainId,
            did,
            this.user._id,
            content,
            this.request.ip,
            filename,
            filePath,
            fileMeta.size ?? 0,
            fileMeta.lastModified ?? new Date(),
            fileMeta.etag ?? ''
        );
        this.back({ drid });

        const replyDoc: HubReplyDoc = {
            docId: did,
            parentId: this.ddoc.parentId,
            ip: this.request.ip,
            content: content,
            reply: [],
            react: {},
            files: [fileData],
        };

        this.response.body = { replyDoc };
        this.response.redirect = this.url('hub_detail', { did });
        console.log('files', fileData);
        console.log('replyDoc', replyDoc);
    }






    @param('drid', Types.ObjectId)
    @param('content', Types.Content)
    async postTailReply(domainId: string, drid: ObjectId, content: string, filename: string) {
        this.checkPerm(PERM.PERM_REPLY_DISCUSSION);
        if (this.ddoc.lock) throw new DiscussionLockedError(domainId, this.ddoc.docId);
        await this.limitRate('add_discussion', 3600, 60);

        if (!filename || typeof filename !== 'string') {
            throw new ValidationError('Filename is required and must be a string.');
        }

        const file = this.request.files?.file;
        if (!file) {
            throw new ValidationError('A file must be uploaded to create a reply.');
        }

        const filePath = `hub/${domainId}/${drid}/${filename}`;
        await storage.put(filePath, file.filepath, this.user._id);
        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) {
            throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);
        }

        const fileData = {
            filename: filename,
            path: filePath,
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };

        await Hub.addTailReplyWithFile(
            domainId,
            drid,
            this.user._id,
            content,
            this.request.ip,
            filename,
            filePath,
            fileMeta.size ?? 0,
            fileMeta.lastModified ?? new Date(),
            fileMeta.etag ?? ''
        );

        const targets = new Set(Array.from(content.matchAll(/@\[\]\(\/user\/(\d+)\)/g)).map((i) => +i[1]));
        const uids = Object.keys(await user.getList(domainId, Array.from(targets))).map((i) => +i);
        const msg = JSON.stringify({
            message: 'User {0} mentioned you in {1:link}',
            params: [this.user.uname, `/d/${domainId}${this.request.path}`],
        });
        for (const uid of uids) {
            message.send(1, uid, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD);
        }

        this.back();
    }

    @param('drid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditReply(domainId: string, drid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        if (!this.user.own(this.drdoc)) throw new PermissionError(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        await Promise.all([
            discussion.editReply(domainId, drid, content, this.user._id, this.request.ip),
            oplog.log(this, 'discussion.reply.edit', this.drdoc),
        ]);
        this.back();
    }

    @param('drid', Types.ObjectId)
    async postDeleteReply(domainId: string, drid: ObjectId) {
        const deleteBy = this.user.own(this.drdoc) ? 'self' : this.user.own(this.ddoc) ? 'DiscussionOwner' : 'Admin';
        if (!(this.user.own(this.ddoc)
            && this.user.hasPerm(PERM.PERM_DELETE_DISCUSSION_REPLY_SELF_DISCUSSION))) {
            if (!this.user.own(this.drdoc)) {
                this.checkPerm(PERM.PERM_DELETE_DISCUSSION_REPLY);
            } else this.checkPerm(PERM.PERM_DELETE_DISCUSSION_REPLY_SELF);
        }
        const msg = JSON.stringify({
            message: '{0} {1} delete your discussion reply {2} in "{3}"({4:link}).',
            params: [
                deleteBy,
                this.user.uname,
                this.drdoc.content.length > 10 ? `${this.drdoc.content.substring(0, 10)}...` : `${this.drdoc.content}`,
                this.ddoc.title,
                `/d/${domainId}${this.request.path}`,
            ],
        });
        await Promise.all([
            discussion.delReply(domainId, drid),
            deleteBy !== 'self' && message.send(1, this.drdoc.owner, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD),
            oplog.log(this, 'discussion.reply.delete', this.drdoc),
        ]);
        this.back();
    }

    @param('drid', Types.ObjectId)
    @param('drrid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditTailReply(domainId: string, drid: ObjectId, drrid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        if (!this.user.own(this.drrdoc)) throw new PermissionError(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        await Promise.all([
            discussion.editTailReply(domainId, drid, drrid, content, this.user._id, this.request.ip),
            oplog.log(this, 'discussion.tailReply.edit', this.drrdoc),
        ]);
        this.back();
    }

    @param('drid', Types.ObjectId)
    @param('drrid', Types.ObjectId)
    async postDeleteTailReply(domainId: string, drid: ObjectId, drrid: ObjectId) {
        const deleteBy = this.user.own(this.drrdoc) ? 'self' : 'Admin';
        if (!(this.user.own(this.drrdoc)
            && this.user.hasPerm(PERM.PERM_DELETE_DISCUSSION_REPLY_SELF))) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION_REPLY);
        }
        const msg = JSON.stringify({
            message: 'Admin {0} delete your discussion tail reply {1} in "{2}"({3:link}).',
            params: [
                this.user.uname,
                this.drrdoc.content.length > 10 ? `${this.drrdoc.content.substring(0, 10)}...` : this.drrdoc.content,
                this.ddoc.title,
                `/d/${domainId}${this.request.path}`,
            ],
        });
        await Promise.all([
            discussion.delTailReply(domainId, drid, drrid),
            deleteBy !== 'self' && message.send(1, this.drrdoc.owner, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD),
            oplog.log(this, 'discussion.tailReply.delete', this.drrdoc),
        ]);
        this.back();
    }

    @param('did', Types.ObjectId)
    async postStar(domainId: string, did: ObjectId) {
        await discussion.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await discussion.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}

class DiscussionRawHandler extends DiscussionHandler {
    @param('did', Types.ObjectId, true)
    @param('drid', Types.ObjectId, true)
    @param('drrid', Types.ObjectId, true)
    @param('time', Types.UnsignedInt, true)
    @param('all', Types.Boolean)
    async get(domainId: string, did: ObjectId, drid: ObjectId, drrid: ObjectId, ts: number, all = false) {
        if (all) {
            this.response.body.history = await discussion.getHistory(domainId, drrid || drid || did);
        } else {
            const [doc] = await discussion.getHistory(domainId, drrid || drid || did, ts ? { time: new Date(ts) } : {});
            if (!doc) {
                if (ts) throw new DiscussionNotFoundError(drrid || drid || did);
                if (drrid && !this.drrdoc) throw new DiscussionNotFoundError(drrid);
                if (drid && !this.drdoc) throw new DiscussionNotFoundError(drid);
                if (did && !this.ddoc) throw new DiscussionNotFoundError(did);
            }
            this.response.type = 'text/markdown';
            this.response.body = doc ? doc.content : drrid ? this.drrdoc.content : drid ? this.drdoc.content : this.ddoc.content;
        }
    }
}

class DiscussionEditHandler extends DiscussionHandler {
    async get() {
        const path = [
            ['Ejunz', 'homepage'],
            ['discussion_main', 'discussion_main'],
            [this.vnode.title, 'discussion_node', { type: discussion.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, 'discussion_detail', { did: this.ddoc.docId }, true],
            ['discussion_edit', null],
        ];
        this.response.template = 'discussion_edit.html';
        this.response.body = { ddoc: this.ddoc, path };
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async postUpdate(
        domainId: string, did: ObjectId, title: string, content: string,
        highlight = false, pin = false,
    ) {
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        else this.checkPerm(PERM.PERM_EDIT_DISCUSSION_SELF);
        if (!this.user.hasPerm(PERM.PERM_HIGHLIGHT_DISCUSSION)) highlight = this.ddoc.highlight;
        if (!this.user.hasPerm(PERM.PERM_PIN_DISCUSSION)) pin = this.ddoc.pin;
        const hidden = this.vnode.hidden ?? false;
        await Promise.all([
            discussion.edit(domainId, did, {
                title, highlight, pin, content, editor: this.user._id, edited: true, hidden,
            }),
            oplog.log(this, 'discussion.edit', this.ddoc),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('discussion_detail', { did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        const deleteBy = this.user.own(this.ddoc) ? 'self' : 'Admin';
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        else this.checkPerm(PERM.PERM_DELETE_DISCUSSION_SELF);
        const msg = JSON.stringify({
            message: 'Admin {0} delete your discussion "{1}".',
            params: [
                this.user.uname,
                this.ddoc.title,
            ],
        });
        await Promise.all([
            oplog.log(this, 'discussion.delete', this.ddoc),
            deleteBy !== 'self' && message.send(1, this.ddoc.owner, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD),
            discussion.del(domainId, did),
        ]);
        this.response.body = { type: this.ddoc.parentType, parent: this.ddoc.parentId };
        this.response.redirect = this.url('discussion_node', {
            type: discussion.typeDisplay[this.ddoc.parentType],
            name: this.ddoc.parentId,
        });
    }
}

export async function apply(ctx) {
    ctx.Route('hu_main', '/hub', DiscussionMainHandler);
    ctx.Route('hub_detail', '/hub/:did/files', DiscussionDetailHandler);
    ctx.Route('hub_edit', '/hub/:did/edit', DiscussionEditHandler);
    ctx.Route('hub_raw', '/hub/:did/raw', DiscussionRawHandler);
    ctx.Route('hub_reply_raw', '/hub/:did/:drid/raw', DiscussionRawHandler);
    ctx.Route('hub_tail_reply_raw', '/hub/:did/:drid/:drrid/raw', DiscussionRawHandler);
    ctx.Route('hub_node', '/hub/:type/:name', DiscussionNodeHandler);
    ctx.Route('hub_create', '/hub/:type/:name/create', DiscussionCreateHandler, PRIV.PRIV_USER_PROFILE, PERM.PERM_CREATE_DISCUSSION);
    ctx.Route('hub_fs_download', '/hub/:did/files/:filename', HUBFSDownloadHandler);
}

