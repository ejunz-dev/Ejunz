import { Filter } from 'mongodb';
import * as document from './document';
import { BaseModel } from './base';
import type { BaseNode, PluginDoc } from '../interface';
import { PRIV } from './builtin';

export type PluginVisibility = 'private' | 'domain' | 'system';

export interface PluginCreateOptions {
    pluginSlug?: string;
    enabled?: boolean;
    visibility?: PluginVisibility;
    version?: string;
    tag?: string[];
}

export class PluginModel {
    static async generateNextDocId(domainId: string): Promise<number> {
        return BaseModel.generateNextDocId(domainId, document.TYPE_PLUGIN);
    }

    static async create(
        domainId: string,
        owner: number,
        title: string,
        content = '',
        ip?: string,
        options: PluginCreateOptions = {},
    ): Promise<{ docId: number }> {
        const rootNodeData: Partial<BaseNode> = {
            data: {
                pluginNodeType: 'folder',
                slug: options.pluginSlug || this.slugify(title) || 'plugin',
                description: content || '',
                enabled: true,
            },
        };
        return BaseModel.create(
            domainId,
            owner,
            title || 'Untitled Plugin',
            content || '',
            undefined,
            'main',
            ip,
            undefined,
            title || 'Plugin',
            true,
            undefined,
            options.tag,
            document.TYPE_PLUGIN,
            rootNodeData,
            {
                pluginSlug: options.pluginSlug || this.slugify(title),
                enabled: options.enabled !== false,
                visibility: options.visibility || 'private',
                version: options.version || '0.1.0',
                source: { type: 'web' },
            } as Partial<PluginDoc>,
        );
    }

    static async get(domainId: string, docId: number): Promise<PluginDoc | null> {
        return (await BaseModel.get(domainId, docId, document.TYPE_PLUGIN)) as PluginDoc | null;
    }

    static async getAll(domainId: string, query: Filter<PluginDoc> = {}): Promise<PluginDoc[]> {
        return (await BaseModel.getAll(domainId, query as any, document.TYPE_PLUGIN)) as PluginDoc[];
    }

    static async update(domainId: string, docId: number, updates: Partial<PluginDoc>): Promise<void> {
        await document.set(domainId, document.TYPE_PLUGIN, docId, {
            ...updates,
            updateAt: new Date(),
        } as Partial<PluginDoc>);
    }

    static async delete(domainId: string, docId: number): Promise<void> {
        await document.deleteOne(domainId, document.TYPE_PLUGIN, docId);
    }

    static canRead(user: any, plugin: PluginDoc): boolean {
        return plugin.enabled !== false && (
            plugin.visibility === 'domain'
            || plugin.visibility === 'system'
            || user?.own?.(plugin)
            || user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM)
        );
    }

    static canEdit(user: any, plugin: PluginDoc): boolean {
        return !!(user?.own?.(plugin) || user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM));
    }

    static slugify(raw: string): string {
        return String(raw || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80);
    }
}

export default PluginModel;
