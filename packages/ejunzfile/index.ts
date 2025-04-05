
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
    const PERM = {
        PERM_VIEW_DOMAIN_FILES: 1n << 76n,
    };

    ctx.Route('domain_files', '/domainfile', DomainFilesHandler,PERM.PERM_VIEW_DOMAIN_FILES);
    ctx.Route('domain_fs_download', '/domainfile/:filename', DomainFSDownloadHandler,PERM.PERM_VIEW_DOMAIN_FILES);


    global.Ejunz.model.builtin.registerPermission(
        'plugins',
        PERM.PERM_VIEW_DOMAIN_FILES, 
        'View domain files',
        true,
        'ejunzfile'
    );


    const customChecker = (handler) => {
        if (handler.user._id === 2) {
            console.log('用户是superadmin', handler.user._id);
            return true;
        } else {
            const hasPermission = handler.user.hasPerm(PERM.PERM_VIEW_DOMAIN_FILES);
            console.log(`User ${handler.user._id} has permission: ${hasPermission}`);
            return hasPermission;
        }
        
    };
    
    function ToOverrideNav(h) {
        if (!h.response.body.overrideNav) {
            h.response.body.overrideNav = [];
        }

        h.response.body.overrideNav.push(
            {
                name: 'domain_files',
                args: {},
                displayName: 'domain_files',
                checker: customChecker,
            },

        );
        
    }

    ctx.on('handler/after/Filespace#get', async (h) => {
        ToOverrideNav(h);
    });

    ctx.on('handler/after', async (h) => {
        if (h.request.path.includes('/domainfile')) {
            if (!h.response.body.overrideNav) {
                h.response.body.overrideNav = [];
            }
            h.response.body.overrideNav.push(
                {
                    name: 'domain_files',
                    args: {},
                    displayName: 'domain_files',
                    checker: customChecker,
                }
            );
        }
    });


    ctx.i18n.load('zh', {
        "{0}'s domain_files": '{0} 的文件',
        domain_files: '域文件',
        domain_files_detail: '文件详情',
        domain_files_edit: '编辑文件',
        domain_files_main: '文件',
    });
    ctx.i18n.load('zh_TW', {
        "{0}'s domain_files": '{0} 的檔案',
        domain_files: '檔案',
        domain_files_detail: '檔案詳情',
        domain_files_edit: '編輯檔案',
        domain_files_main: '檔案',
    });
    ctx.i18n.load('kr', {
        "{0}'s domain_files": '{0}의 파일',
        domain_files: '파일',
        domain_files_main: '파일',
        domain_files_detail: '파일 상세',
        domain_files_edit: '파일 수정',
    });
    ctx.i18n.load('en', {
        domain_files_main: 'Domain Files',
        domain_files_detail: 'Domain Files Detail',
        domain_files_edit: 'Edit Domain Files',
    });
    
}