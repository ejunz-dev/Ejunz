import { writeHeapSnapshot } from 'v8';
import { pick } from 'lodash';
import { lookup } from 'mime-types';
import { Context } from '../context';
import {
    AccessDeniedError, FileExistsError, FileLimitExceededError, FileUploadError, NotFoundError,
    ValidationError,
} from '../error';
import { PRIV } from '../model/builtin';
import * as oplog from '../model/oplog';
import storage from '../model/storage';
import system from '../model/system';
import user, { User } from '../model/user';
import {
    Handler, param, post, requireSudo, route, Types,
} from '../service/server';
import { encodeRFC5987ValueChars } from '../service/storage';
import { sortFiles } from '../utils';

function buildSignedStorageUrl(filename: string, target: string, expire: number | string, secret: string, inline = true) {
    const qs = new URLSearchParams({
        target,
        expire: String(expire),
        secret,
    });
    if (inline) qs.set('inline', '1');
    return `/storage/${encodeURIComponent(filename)}?${qs.toString()}`;
}

function escapeHtml(text: string) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildInlineFileViewHtml(filename: string, storageUrl: string) {
    const title = escapeHtml(filename);
    const src = escapeHtml(storageUrl);
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    let body = '';
    if (['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) {
        body = `<style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111}img{max-width:100%;max-height:100vh;object-fit:contain}</style><img src="${src}" alt="">`;
    } else if (ext === 'pdf') {
        body = `<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe src="${src}"></iframe>`;
    } else if (['mp4', 'webm', 'ogg'].includes(ext)) {
        const type = ext === 'ogg' ? 'video/ogg' : ext === 'webm' ? 'video/webm' : 'video/mp4';
        body = `<style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111}video{max-width:100%;max-height:100vh}</style><video controls><source src="${src}" type="${type}"></video>`;
    } else {
        body = `<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe src="${src}"></iframe>`;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

class SwitchLanguageHandler extends Handler {
    noCheckPermView = true;

    @param('lang', Types.Name)
    async get(domainId: string, lang: string) {
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            this.session.viewLang = lang;
            await user.setById(this.user._id, { viewLang: lang });
        } else this.session.viewLang = lang;
        this.back();
    }
}

export class FilesHandler extends Handler {
    noCheckPermView = true;
    udoc: User;

    @param('uid', Types.Int, true)
    async prepare({ domainId }, uid: number) {
        if (uid) {
            this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
            this.udoc = await (await user.getById(domainId, uid)).private();
        } else {
            this.udoc = this.user;
        }
    }

    async get({ }) {
        if (!this.udoc._files?.length) this.checkPriv(PRIV.PRIV_CREATE_FILE);
        const files = sortFiles(this.udoc._files).map((file) => {
            let lastModified: Date | null = null;
            if (file.lastModified) {
                lastModified = file.lastModified instanceof Date ? file.lastModified : new Date(file.lastModified);
            }
            return {
                ...file,
                lastModified,
            };
        });
        this.response.body = {
            files,
            urlForFile: (filename: string) => this.url('fs_download', { uid: this.udoc._id, filename }),
            urlForFilePreview: (filename: string) => this.url('fs_download', { uid: this.udoc._id, filename, noDisposition: 1 }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'home_files.html';
    }

    @post('filename', Types.Filename)
    async postUploadFile({ }, filename: string) {
        this.checkPriv(PRIV.PRIV_CREATE_FILE);
        if ((this.user._files?.length || 0) >= system.get('limit.user_files')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = Math.sum((this.user._files || []).map((i) => i.size)) + file.size;
        if (size >= system.get('limit.user_files_size')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('size');
        }
        if (this.user._files.find((i) => i.name === filename)) throw new FileExistsError(filename);
        await storage.put(`user/${this.user._id}/${filename}`, file.filepath, this.user._id);
        const meta = await storage.getMeta(`user/${this.user._id}/${filename}`);
        const payload = { name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        this.user._files.push({ _id: filename, ...payload });
        await user.setById(this.user._id, { _files: this.user._files });
        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles({ }, files: string[]) {
        await Promise.all([
            storage.del(files.map((t) => `user/${this.udoc._id}/${t}`), this.user._id),
            user.setById(this.udoc._id, { _files: this.udoc._files.filter((i) => !files.includes(i.name)) }),
        ]);
        this.back();
    }
}

export class FSDownloadHandler extends Handler {
    noCheckPermView = true;

    @param('uid', Types.Int)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    @param('view', Types.Boolean)
    async get(domainId: string, uid: number, filename: string, noDisposition = false, view = false) {
        const target = `user/${uid}/${filename}`;
        const file = await storage.getMeta(target);
        await oplog.log(this, 'download.file.user', {
            target,
            size: file?.size || 0,
        });
        try {
            this.response.redirect = await storage.signDownloadLink(
                target, filename, false, 'user', noDisposition, noDisposition && view,
            );
            this.response.addHeader('Cache-Control', 'public');
        } catch (e) {
            if (e.message.includes('Invalid path')) throw new NotFoundError(filename);
            throw e;
        }
    }
}

export class StorageHandler extends Handler {
    noCheckPermView = true;
    notUsage = true;

    @route('filename', Types.Filename, true)
    @param('target', Types.Name)
    @param('inline', Types.Boolean, true)
    @param('expire', Types.UnsignedInt)
    @param('secret', Types.String)
    async get({ }, filename = '', target: string, inline = false, expire: number, secret: string) {
        if (expire < Date.now()) throw new AccessDeniedError();
        if (!(await this.ctx.get('storage')?.isLinkValid?.(`${target}/${expire}/${secret}`))) throw new AccessDeniedError();
        this.response.body = await storage.get(target);
        this.response.type = (target.endsWith('.out') || target.endsWith('.ans'))
            ? 'text/plain'
            : lookup(target) || 'application/octet-stream';
        if (filename) {
            const disposition = inline ? 'inline' : 'attachment';
            this.response.disposition = `${disposition}; filename="${encodeRFC5987ValueChars(filename)}"`;
        }
    }
}

export class FileViewHandler extends Handler {
    noCheckPermView = true;
    notUsage = true;

    @route('filename', Types.Filename)
    @param('target', Types.Name)
    @param('expire', Types.UnsignedInt)
    @param('secret', Types.String)
    async get({ }, filename: string, target: string, expire: number, secret: string) {
        if (expire < Date.now()) throw new AccessDeniedError();
        if (!(await this.ctx.get('storage')?.isLinkValid?.(`${target}/${expire}/${secret}`))) throw new AccessDeniedError();
        const storageUrl = buildSignedStorageUrl(filename, target, expire, secret);
        this.response.type = 'text/html';
        this.response.body = buildInlineFileViewHtml(filename, storageUrl);
    }
}

export class SwitchAccountHandler extends Handler {
    @requireSudo
    @param('uid', Types.Int)
    async get({ }, uid: number) {
        this.session.sudoUid = this.user._id;
        this.session.uid = uid;
        this.back();
    }
}

class HeapSnapshotHandler extends Handler {
    @param('worker', Types.Int)
    async post({ }, worker: number) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        if (worker && process.env.NODE_APP_INSTANCE !== worker.toString()) {
            this.response.body = { error: 'Not current worker' };
            return;
        }
        this.response.body = {
            worker: process.env.NODE_APP_INSTANCE,
            filename: writeHeapSnapshot(),
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('switch_language', '/language/:lang', SwitchLanguageHandler);
    ctx.Route('home_files', '/file', FilesHandler);
    ctx.Route('file_view', '/file/view/:filename', FileViewHandler);
    ctx.Route('fs_download', '/file/:uid/:filename', FSDownloadHandler);
    ctx.Route('storage_named', '/storage/:filename', StorageHandler);
    ctx.Route('storage', '/storage', StorageHandler);
    ctx.Route('switch_account', '/account/:uid', SwitchAccountHandler, PRIV.PRIV_EDIT_SYSTEM);
    if (process.argv.includes('--enable-heap-snapshot')) {
        ctx.Route('heap_snapshot', '/heap-snapshot', HeapSnapshotHandler, PRIV.PRIV_EDIT_SYSTEM);
    }
}