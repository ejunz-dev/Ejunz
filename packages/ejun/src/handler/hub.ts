import { isSafeInteger } from 'lodash';
import { ObjectId } from 'mongodb';
import {
    HubLockedError, HubNodeNotFoundError, HubNotFoundError, DocumentNotFoundError,
    PermissionError,
} from '../error';
import { HubDoc, HubReplyDoc, HubTailReplyDoc } from '../interface';
import { PERM, PRIV } from '../model/builtin';
import * as hub from '../model/hub';
import * as document from '../model/document';
import message from '../model/message';
import * as oplog from '../model/oplog';
import user from '../model/user';
import { Handler, param, Types } from '../service/server';

export const typeMapper = {
    problem: document.TYPE_PROBLEM,
    contest: document.TYPE_CONTEST,
    node: document.TYPE_HUB_NODE,
    training: document.TYPE_TRAINING,
    homework: document.TYPE_CONTEST,
    docs: document.TYPE_DOCS,
};

class HubHandler extends Handler {
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
        this.checkPerm(PERM.PERM_VIEW_HUB);
        if (did) {
            this.ddoc = await hub.get(domainId, did);
            if (!this.ddoc) throw new HubNotFoundError(domainId, did);
            type = hub.typeDisplay[this.ddoc.parentType];
            name = this.ddoc.parentId.toString();
            if (drrid) {
                [this.drdoc, this.drrdoc] = await hub.getTailReply(domainId, drid, drrid);
                if (!this.drrdoc) throw new HubNotFoundError(domainId, drrid);
            } else if (drid) {
                this.drdoc = await hub.getReply(domainId, drid);
                if (!this.drdoc) throw new HubNotFoundError(domainId, drid);
                if (!this.drdoc.parentId.equals(this.ddoc._id)) {
                    throw new DocumentNotFoundError(domainId, drid);
                }
            }
        }
        // TODO(twd2): exclude problem/contest discussions?
        // TODO(iceboy): continuation based pagination.
        this.vnode = await hub.getVnode(domainId, typeMapper[type], name, this.user._id);
        if (!hub.checkVNodeVisibility(typeMapper[type], this.vnode, this.user)) throw new HubNodeNotFoundError(this.vnode.id);
        if (this.ddoc) {
            this.ddoc.parentType ||= this.vnode.type;
            this.ddoc.parentId ||= this.vnode.id;
        }
    }
}

class HubMainHandler extends Handler {
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
            hub.getMulti(domainId, { parentType, ...all ? {} : { hidden: false } }),
            page,
            'hub',
        );
        const udict = await user.getList(domainId, ddocs.map((ddoc) => ddoc.owner));
        const [vndict, vnodes] = await Promise.all([
            hub.getListVnodes(domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group),
            hub.getNodes(domainId),
        ]);
        this.response.template = 'hub_main_or_node.html';
        this.response.body = {
            ddocs, dpcount, udict, page, page_name: 'hub_main', vndict, vnode: {}, vnodes,
        };
        console.log('response',this.response.body)
    }
}

class HubNodeHandler extends HubHandler {
    @param('type', Types.Range(Object.keys(typeMapper)))
    @param('name', Types.String)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, type: string, _name: string, page = 1) {
        let name: ObjectId | string | number;
        if (ObjectId.isValid(_name)) name = new ObjectId(_name);
        else if (isSafeInteger(parseInt(_name, 10))) name = parseInt(_name, 10);
        else name = _name;
        const hidden = this.user.own(this.vnode) || this.user.hasPerm(PERM.PERM_EDIT_HUB) ? {} : { hidden: false };
        const [ddocs, dpcount] = await this.paginate(
            hub.getMulti(domainId, { parentType: typeMapper[type], parentId: name, ...hidden }),
            page,
            'hub',
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(this.vnode.owner);
        const [udict, vnodes] = await Promise.all([
            user.getList(domainId, uids),
            hub.getNodes(domainId),
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

class HubCreateHandler extends HubHandler {
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
        await this.limitRate('add_hub', 3600, 60);

        if (highlight) this.checkPerm(PERM.PERM_HIGHLIGHT_HUB);
        if (pin) this.checkPerm(PERM.PERM_PIN_HUB);

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
        const did = await hub.add(
            domainId, typeMapper[type], resolvedId, this.user._id,
            title, content, this.request.ip, highlight, pin, hidden,
        );

        this.response.body = { did };
        this.response.redirect = this.url('hub_detail', { did });

console.log('vnode:', this.vnode);


    }
}


class HubDetailHandler extends HubHandler {
    @param('did', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, did: ObjectId, page = 1) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await hub.getStatus(domainId, did, this.user._id)
            : null;
        const [drdocs, pcount, drcount] = await this.paginate(
            hub.getMultiReply(domainId, did),
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
            hub.getReaction(domainId, document.TYPE_HUB_REPLY, drdoc._id, this.user._id).then((reaction) => {
                reactions[drdoc._id.toHexString()] = reaction;
            })));
        const udict = await user.getList(domainId, uids);
        if (!dsdoc?.view && this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            await Promise.all([
                hub.inc(domainId, did, 'views', 1),
                hub.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        const path = [
            ['Ejunz', 'homepage'],
            ['hub_main', 'hub_main'],
            [this.vnode.title, 'hub_node', { type: hub.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, null, null, true],
        ];
        this.response.template = 'hub_detail.html';
        this.response.body = {
            path, ddoc: this.ddoc, dsdoc, drdocs, page, pcount, drcount, udict, vnode: this.vnode, reactions,
        };
        console.log('typeDisplay',{ type: hub.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId })
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectId)
    @param('lock', Types.Boolean)
    async postSetLock(domainId: string, did: ObjectId, lock: boolean) {
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_LOCK_HUB);
        await hub.edit(domainId, did, { lock });
        this.back();
    }

    @param('nodeType', Types.Range(['did', 'drid']))
    @param('id', Types.ObjectId)
    @param('emoji', Types.Emoji)
    @param('reverse', Types.Boolean)
    async postReaction(domainId: string, type: string, did: ObjectId, id: string, reverse = false) {
        this.checkPerm(PERM.PERM_ADD_REACTION);
        const docType = type === 'did' ? document.TYPE_HUB : document.TYPE_HUB_REPLY;
        const [doc, sdoc] = await hub.react(domainId, docType, did, id, this.user._id, reverse);
        this.response.body = { doc, sdoc };
        this.back();
    }

    @param('did', Types.ObjectId)
    @param('content', Types.Content)
    async postReply(domainId: string, did: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_REPLY_HUB);
        if (this.ddoc.lock) throw new HubLockedError(domainId, did);
        await this.limitRate('add_hub', 3600, 60);
        const targets = new Set(Array.from(content.matchAll(/@\[\]\(\/user\/(\d+)\)/g)).map((i) => +i[1]));
        const uids = Object.keys(await user.getList(domainId, Array.from(targets))).map((i) => +i);
        const msg = JSON.stringify({
            message: 'User {0} mentioned you in {1:link}',
            params: [this.user.uname, `/d/${domainId}${this.request.path}`],
        });
        for (const uid of uids) {
            message.send(1, uid, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD);
        }
        const drid = await hub.addReply(domainId, did, this.user._id, content, this.request.ip);
        this.back({ drid });
    }

    @param('drid', Types.ObjectId)
    @param('content', Types.Content)
    async postTailReply(domainId: string, drid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_REPLY_HUB);
        if (this.ddoc.lock) throw new HubLockedError(domainId, this.ddoc.docId);
        await this.limitRate('add_hub', 3600, 60);
        const targets = new Set(Array.from(content.matchAll(/@\[\]\(\/user\/(\d+)\)/g)).map((i) => +i[1]));
        const uids = Object.keys(await user.getList(domainId, Array.from(targets))).map((i) => +i);
        const msg = JSON.stringify({
            message: 'User {0} mentioned you in {1:link}',
            params: [this.user.uname, `/d/${domainId}${this.request.path}`],
        });
        for (const uid of uids) {
            message.send(1, uid, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD);
        }
        await hub.addTailReply(domainId, drid, this.user._id, content, this.request.ip);
        this.back();
    }

    @param('drid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditReply(domainId: string, drid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_EDIT_HUB_REPLY_SELF);
        if (!this.user.own(this.drdoc)) throw new PermissionError(PERM.PERM_EDIT_HUB_REPLY_SELF);
        await Promise.all([
            hub.editReply(domainId, drid, content, this.user._id, this.request.ip),
            oplog.log(this, 'hub.reply.edit', this.drdoc),
        ]);
        this.back();
    }

    @param('drid', Types.ObjectId)
    async postDeleteReply(domainId: string, drid: ObjectId) {
        const deleteBy = this.user.own(this.drdoc) ? 'self' : this.user.own(this.ddoc) ? 'HubOwner' : 'Admin';
        if (!(this.user.own(this.ddoc)
            && this.user.hasPerm(PERM.PERM_DELETE_HUB_REPLY_SELF_HUB))) {
            if (!this.user.own(this.drdoc)) {
                this.checkPerm(PERM.PERM_DELETE_HUB_REPLY);
            } else this.checkPerm(PERM.PERM_DELETE_HUB_REPLY_SELF);
        }
        const msg = JSON.stringify({
            message: '{0} {1} delete your hub reply {2} in "{3}"({4:link}).',
            params: [
                deleteBy,
                this.user.uname,
                this.drdoc.content.length > 10 ? `${this.drdoc.content.substring(0, 10)}...` : `${this.drdoc.content}`,
                this.ddoc.title,
                `/d/${domainId}${this.request.path}`,
            ],
        });
        await Promise.all([
            hub.delReply(domainId, drid),
            deleteBy !== 'self' && message.send(1, this.drdoc.owner, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD),
            oplog.log(this, 'hub.reply.delete', this.drdoc),
        ]);
        this.back();
    }

    @param('drid', Types.ObjectId)
    @param('drrid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditTailReply(domainId: string, drid: ObjectId, drrid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_EDIT_HUB_REPLY_SELF);
        if (!this.user.own(this.drrdoc)) throw new PermissionError(PERM.PERM_EDIT_HUB_REPLY_SELF);
        await Promise.all([
            hub.editTailReply(domainId, drid, drrid, content, this.user._id, this.request.ip),
            oplog.log(this, 'hub.tailReply.edit', this.drrdoc),
        ]);
        this.back();
    }

    @param('drid', Types.ObjectId)
    @param('drrid', Types.ObjectId)
    async postDeleteTailReply(domainId: string, drid: ObjectId, drrid: ObjectId) {
        const deleteBy = this.user.own(this.drrdoc) ? 'self' : 'Admin';
        if (!(this.user.own(this.drrdoc)
            && this.user.hasPerm(PERM.PERM_DELETE_HUB_REPLY_SELF))) {
            this.checkPerm(PERM.PERM_DELETE_HUB_REPLY);
        }
        const msg = JSON.stringify({
            message: 'Admin {0} delete your hub tail reply {1} in "{2}"({3:link}).',
            params: [
                this.user.uname,
                this.drrdoc.content.length > 10 ? `${this.drrdoc.content.substring(0, 10)}...` : this.drrdoc.content,
                this.ddoc.title,
                `/d/${domainId}${this.request.path}`,
            ],
        });
        await Promise.all([
            hub.delTailReply(domainId, drid, drrid),
            deleteBy !== 'self' && message.send(1, this.drrdoc.owner, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD),
            oplog.log(this, 'hub.tailReply.delete', this.drrdoc),
        ]);
        this.back();
    }

    @param('did', Types.ObjectId)
    async postStar(domainId: string, did: ObjectId) {
        await hub.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await hub.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}

class HubRawHandler extends HubHandler {
    @param('did', Types.ObjectId, true)
    @param('drid', Types.ObjectId, true)
    @param('drrid', Types.ObjectId, true)
    @param('time', Types.UnsignedInt, true)
    @param('all', Types.Boolean)
    async get(domainId: string, did: ObjectId, drid: ObjectId, drrid: ObjectId, ts: number, all = false) {
        if (all) {
            this.response.body.history = await hub.getHistory(domainId, drrid || drid || did);
        } else {
            const [doc] = await hub.getHistory(domainId, drrid || drid || did, ts ? { time: new Date(ts) } : {});
            if (!doc) {
                if (ts) throw new HubNotFoundError(drrid || drid || did);
                if (drrid && !this.drrdoc) throw new HubNotFoundError(drrid);
                if (drid && !this.drdoc) throw new HubNotFoundError(drid);
                if (did && !this.ddoc) throw new HubNotFoundError(did);
            }
            this.response.type = 'text/markdown';
            this.response.body = doc ? doc.content : drrid ? this.drrdoc.content : drid ? this.drdoc.content : this.ddoc.content;
        }
    }   
}

class HubEditHandler extends HubHandler {
    async get() {
        const path = [
            ['Ejunz', 'homepage'],
            ['hub_main', 'hub_main'],
            [this.vnode.title, 'hub_node', { type: hub.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, 'hub_detail', { did: this.ddoc.docId }, true],
            ['hub_edit', null],
        ];
        this.response.template = 'hub_edit.html';
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
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_EDIT_HUB);
        else this.checkPerm(PERM.PERM_EDIT_HUB_SELF);
        if (!this.user.hasPerm(PERM.PERM_HIGHLIGHT_HUB)) highlight = this.ddoc.highlight;
        if (!this.user.hasPerm(PERM.PERM_PIN_HUB)) pin = this.ddoc.pin;
        const hidden = this.vnode.hidden ?? false;
        await Promise.all([
            hub.edit(domainId, did, {
                title, highlight, pin, content, editor: this.user._id, edited: true, hidden,
            }),
            oplog.log(this, 'hub.edit', this.ddoc),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('hub_detail', { did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        const deleteBy = this.user.own(this.ddoc) ? 'self' : 'Admin';
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_DELETE_HUB);
        else this.checkPerm(PERM.PERM_DELETE_HUB_SELF);
        const msg = JSON.stringify({
            message: 'Admin {0} delete your hub "{1}".',
            params: [
                this.user.uname,
                this.ddoc.title,
            ],
        });
        await Promise.all([
            oplog.log(this, 'hub.delete', this.ddoc),
            deleteBy !== 'self' && message.send(1, this.ddoc.owner, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD),
            hub.del(domainId, did),
        ]);
        this.response.body = { type: this.ddoc.parentType, parent: this.ddoc.parentId };
        this.response.redirect = this.url('discussion_node', {
            type: hub.typeDisplay[this.ddoc.parentType],
            name: this.ddoc.parentId,
        });
    }
}

export async function apply(ctx) {
    ctx.Route('hub_main', '/hub', HubMainHandler);
    ctx.Route('hub_detail', '/hub/:did', HubDetailHandler);
    ctx.Route('hub_edit', '/hub/:did/edit', HubEditHandler);
    ctx.Route('hub_raw', '/hub/:did/raw', HubRawHandler);
    ctx.Route('hub_reply_raw', '/hub/:did/:drid/raw', HubRawHandler);
    ctx.Route('hub_tail_reply_raw', '/hub/:did/:drid/:drrid/raw', HubRawHandler);
    ctx.Route('hub_node', '/hub/:type/:name', HubNodeHandler);
    ctx.Route('hub_create', '/hub/:type/:name/create', HubCreateHandler, PRIV.PRIV_USER_PROFILE, PERM.PERM_CREATE_HUB);
}
