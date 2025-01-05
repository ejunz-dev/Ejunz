
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
    
        console.log('Resolved domain:', domain);
        if (!domain) throw new Error('Domain not found.');
    
        this.response.body = {
            files: sortFiles(domain.files),

            urlForFile: (userId, filename) => this.url('domain_fs_download', {
                domainId: this.args.domainId || this.context.domainId,
                userId: userId,
                filename,
            }),
            
        };

        console.log('Response Body:', this.response.body);

        this.response.pjax = 'partials/files.html';
        this.response.template = 'domain_files.html';
    }

    @post('filename', Types.Filename)
    async postUploadFile(domainId: string, filename: string) {
        const userId = this.user._id;

        const domain = await DomainModel.get(domainId);
        if (!domain) throw new Error('Domain not found.');

        domain.files = domain.files || [];

        if (domain.files.find((file) => file.name === filename && file.userId === userId)) {
            throw new Error(`File "${filename}" already exists for userId: ${userId}.`);
        }

        const file = this.request.files?.file;
        if (!file) throw new Error('No file uploaded.');
        const f = statSync(file.filepath);

        const filePath = `domain/${domainId}/${userId}/${filename}`;
        await StorageModel.put(filePath, file.filepath);

        const meta = await StorageModel.getMeta(filePath);
        const payload = {
            name: filename,
            userId,
            ...pick(meta, ['size', 'lastModified', 'etag']),
        };

        domain.files.push(payload);
        await DomainModel.edit(domainId, { files: domain.files });

        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, files: string[]) {
        if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) {
            throw new ValidationError('Expected "files" to be an array of strings');
        }

        const userId = this.user._id;
        const domain = await DomainModel.get(domainId);
        if (!domain) throw new ValidationError('Domain not found.');

        const filePaths = files.map((file) => `domain/${domainId}/${userId}/${file}`);
        console.log('Files to delete from storage:', filePaths);

        await Promise.all([
            StorageModel.del(filePaths),
            DomainModel.edit(domainId, {
                files: domain.files.filter((f) => !files.includes(f.name)),
            }),
        ]);

        console.log('Files successfully deleted');
        this.back();
    }
}

export class FSDownloadHandler extends Handler {
    noCheckPermView = true;

    @param('domainId', Types.Name)
    @param('userId', Types.Name)
    @param('filename', Types.Filename)
    async get(domainId: string, userId: string, filename: string) {
        const target = `domain/${domainId}/${userId}/${filename}`;
        console.log('Download request for target:', target);
        console.log('Download handler params:', { domainId, userId, filename });

        const file = await StorageModel.getMeta(target);
        if (!file) {
            console.error(`File not found: ${target}`);
            throw new NotFoundError(`File "${filename}" does not exist.`);
        }

        try {
            this.response.redirect = await StorageModel.signDownloadLink(target, filename, false);
            this.response.addHeader('Cache-Control', 'public');
        } catch (e) {
            throw new Error(`Error downloading file "${filename}": ${e.message}`);
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
    async get(target: string, filename = '', expire: number, secret: string) {
        const expectedSignature = md5(`${target}/${expire}/${builtinConfig.file.secret}`);

        if (expire < Date.now()) {
            throw new AccessDeniedError('Link has expired.');
        }

        if (secret !== expectedSignature) {
            console.error(`Invalid signature. Expected: ${expectedSignature}, Received: ${secret}`);
            throw new AccessDeniedError('Invalid signature.');
        }

        const file = await StorageModel.getMeta(target);
        if (!file) {
            throw new NotFoundError(`File "${target}" does not exist.`);
        }

        this.response.body = await StorageModel.get(target);
        this.response.type = lookup(target) || 'application/octet-stream';

        if (filename) {
            this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
        }
    }
}



export async function apply(ctx) {
    ctx.Route('domain_files', '/domainfile', DomainFilesHandler);
    ctx.Route('domain_fs_download', '/domainfile/:domainId/:userId/:filename', FSDownloadHandler);
    ctx.Route('storage', '/storage', StorageHandler);

    ctx.injectUI('Nav', 'domain_files', () => ({
        name: 'domain_files',
        displayName: 'domain_files',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}