
import { AccessDeniedError, FileExistsError, FileLimitExceededError, FileUploadError, NotFoundError,
    ValidationError,PRIV,OplogModel,StorageModel,SystemModel, Handler, UserModel,user,param, post, requireSudo, Types,encodeRFC5987ValueChars,
    builtinConfig,md5, sortFiles,DomainModel, } from "ejun"

import { statSync } from 'fs';
import { pick } from 'lodash';
import { lookup } from 'mime-types';

export class DomainFilesHandler extends Handler {
    noCheckPermView = true;

    async resolveDomainId(): Promise<string> {
        return this.args?.domainId || this.context?.domainId;
    }

    async get() {
        const domainId = await this.resolveDomainId();
        const domain = await DomainModel.get(domainId);

        if (!domain) throw new NotFoundError('Domain not found.');

        this.response.body = {
            files: sortFiles(domain.files),
            urlForFile: (filename: string) =>
                this.url('domain_fs_download', { domainId, filename }),
        };

        this.response.pjax = 'partials/files.html';
        this.response.template = 'domain_files.html';
    }

    @post('filename', Types.Filename)
    async postUploadFile(domainId: string, filename: string) {
        console.log("Uploading file:", filename, "to domainId:", domainId);
        console.log('Decorators applied on postUploadFile:', { domainId, filename });

        const userId = this.user._id;

        const domain = await DomainModel.get(domainId);
        if (!domain) throw new NotFoundError('Domain not found.');

        domain.files = domain.files || [];

        if (domain.files.find((file) => file.name === filename)) {
            throw new FileExistsError(`File "${filename}" already exists.`);
        }

        const file = this.request.files?.file;
        if (!file) throw new ValidationError('No file uploaded.');

        const filePath = `domain/${domainId}/${filename}`;
        await StorageModel.put(filePath, file.filepath);

        const meta = await StorageModel.getMeta(filePath);

        // 在元数据中添加 userId 字段
        const payload = {
            name: filename,
            userId, // 添加上传者的 userId
            ...pick(meta, ['size', 'lastModified', 'etag']),
        };

        domain.files.push(payload);
        await DomainModel.edit(domainId, { files: domain.files });
        console.log("File uploaded and metadata saved successfully:", payload);
        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, files: string[]) {
        if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) {
            throw new ValidationError('Expected "files" to be an array of strings');
        }

        const domain = await DomainModel.get(domainId);
        if (!domain) throw new NotFoundError('Domain not found.');

        const filePaths = files.map((file) => `domain/${domainId}/${file}`);
        await Promise.all([
            StorageModel.del(filePaths),
            DomainModel.edit(domainId, {
                files: domain.files.filter((f) => !files.includes(f.name)),
            }),
        ]);

        this.back();
    }
}



export class DomainFSDownloadHandler extends Handler {
    noCheckPermView = true;

    async get({ filename }: { filename: string }) {
        const domainId = this.args?.domainId || this.context?.domainId || 'default_domain';
        console.log('Resolved params:', { domainId, filename });

        console.log("Entering DomainFSDownloadHandler.get...");
        console.log("Received domainId:", domainId, "filename:", filename);

        const target = `domain/${domainId}/${filename}`;
        const file = await StorageModel.getMeta(target);
        if (!file) {
            throw new NotFoundError(`File "${filename}" does not exist.`);
        }
        console.log("Generated target path:", target);

        const mimeType = lookup(filename) || 'application/octet-stream';
        console.log("File MIME type:", mimeType);

        try {
            this.response.body = await StorageModel.get(target);
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





export async function apply(ctx) {
    ctx.Route('domain_files', '/domainfile', DomainFilesHandler);
    ctx.Route('domain_fs_download', '/domainfile/:filename', DomainFSDownloadHandler);

    ctx.injectUI('Nav', 'domain_files', () => ({
        name: 'domain_files',
        displayName: 'domain_files',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}