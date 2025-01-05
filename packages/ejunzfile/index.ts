
import { AccessDeniedError, FileExistsError, FileLimitExceededError, FileUploadError, NotFoundError,
    ValidationError,PRIV,OplogModel,StorageModel,SystemModel, Handler, UserModel,user,param, post, requireSudo, Types,encodeRFC5987ValueChars,
    builtinConfig,md5, sortFiles } from "ejun"

import { statSync } from 'fs';
import { pick } from 'lodash';
import { lookup } from 'mime-types';

export class DomainFilesHandler extends Handler {
    noCheckPermView = true;

    async get() {
        if (!this.user._files?.length) this.checkPriv(PRIV.PRIV_CREATE_FILE);
        this.response.body = {
            files: sortFiles(this.user._files),
            urlForFile: (filename: string) => this.url('fs_download', { uid: this.user._id, filename }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'domain_files.html';
    }

    @post('filename', Types.Filename)
    async postUploadFile(domainId: string, filename: string) {
        this.checkPriv(PRIV.PRIV_CREATE_FILE);
        if ((this.user._files?.length || 0) >= SystemModel.get('limit.user_files')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const f = statSync(file.filepath);
        const size = Math.sum((this.user._files || []).map((i) => i.size)) + f.size;
        if (size >= SystemModel.get('limit.user_files_size')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('size');
        }
        if (this.user._files.find((i) => i.name === filename)) throw new FileExistsError(filename);
        await StorageModel.put(`user/${this.user._id}/${filename}`, file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(`user/${this.user._id}/${filename}`);
        const payload = { name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        this.user._files.push({ _id: filename, ...payload });
        await UserModel.setById(this.user._id, { _files: this.user._files });
        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, files: string[]) {
        await Promise.all([
            StorageModel.del(files.map((t) => `user/${this.user._id}/${t}`), this.user._id),
            UserModel.setById(this.user._id, { _files: this.user._files.filter((i) => !files.includes(i.name)) }),
        ]);
        this.back();
    }
}

export class FSDownloadHandler extends Handler {
    noCheckPermView = true;

    @param('uid', Types.Int)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get(domainId: string, uid: number, filename: string, noDisposition = false) {
        const target = `user/${uid}/${filename}`;
        const file = await StorageModel.getMeta(target);
        await OplogModel.log(this, 'download.file.user', {
            target,
            size: file?.size || 0,
        });
        try {
            this.response.redirect = await StorageModel.signDownloadLink(
                target, noDisposition ? undefined : filename, false, 'user',
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

    @param('target', Types.Name)
    @param('filename', Types.Filename, true)
    @param('expire', Types.UnsignedInt)
    @param('secret', Types.String)
    async get(domainId: string, target: string, filename = '', expire: number, secret: string) {
        const expected = md5(`${target}/${expire}/${builtinConfig.file.secret}`);
        if (expire < Date.now()) throw new AccessDeniedError();
        if (secret !== expected) throw new AccessDeniedError();
        this.response.body = await StorageModel.get(target);
        this.response.type = (target.endsWith('.out') || target.endsWith('.ans'))
            ? 'text/plain'
            : lookup(target) || 'application/octet-stream';
        if (filename) this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
    }
}



export async function apply(ctx) {
    ctx.Route('domain_files', '/domainfile', DomainFilesHandler);
    ctx.Route('fs_download', '/file/:uid/:filename', FSDownloadHandler);
    ctx.Route('StorageModel', '/StorageModel', StorageHandler);

    ctx.injectUI('Nav', 'domain_files', () => ({
        name: 'domain_files',
        displayName: 'domain_files',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}
