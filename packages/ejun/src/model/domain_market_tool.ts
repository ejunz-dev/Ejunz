import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';

const logger = new Logger('model/domain_market_tool');

/** domain 已启用的市场工具（仅 domainId + toolKey，不创建 Edge） */
export interface DomainMarketToolDoc {
    _id: ObjectId;
    docType: typeof document.TYPE_DOMAIN_MARKET_TOOL;
    docId: string;
    domainId: string;
    toolKey: string;
    owner: number;
    createdAt: Date;
    /** 是否为系统工具（可复制的工具参数中带 system 则识别并直接调用系统工具）；默认 true */
    system?: boolean;
}

class DomainMarketToolModel {
    static async getByDomain(domainId: string): Promise<DomainMarketToolDoc[]> {
        return document.getMulti(domainId, document.TYPE_DOMAIN_MARKET_TOOL as any, {})
            .toArray() as Promise<DomainMarketToolDoc[]>;
    }

    static async has(domainId: string, toolKey: string): Promise<boolean> {
        const list = await document.getMulti(domainId, document.TYPE_DOMAIN_MARKET_TOOL as any, { toolKey })
            .limit(1)
            .toArray();
        return list.length > 0;
    }

    static async add(domainId: string, toolKey: string, owner: number): Promise<DomainMarketToolDoc> {
        const now = new Date();
        await document.add(
            domainId,
            toolKey,
            owner,
            document.TYPE_DOMAIN_MARKET_TOOL as any,
            toolKey as any,
            null,
            null,
            { toolKey, owner, createdAt: now, system: true },
        );
        const list = await document.getMulti(domainId, document.TYPE_DOMAIN_MARKET_TOOL as any, { toolKey })
            .limit(1)
            .toArray();
        return list[0] as DomainMarketToolDoc;
    }

    static async remove(domainId: string, toolKey: string): Promise<void> {
        await document.deleteOne(domainId, document.TYPE_DOMAIN_MARKET_TOOL as any, toolKey as any);
    }
}

export default DomainMarketToolModel;
