import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import db from '../service/db';
import { randomstring } from '../utils';

export interface EdgeTokenDoc {
    _id: ObjectId;
    domainId: string;
    type: 'provider' | 'node' | 'client';
    token: string;
    lastUsedAt: Date;
    createdAt: Date;
    expireAt: Date; // 30分钟后过期（如果未使用）
}

class EdgeTokenModel {
    static coll = db.collection('edge.token' as any);

    static async generateToken(): Promise<string> {
        return randomstring(32);
    }

    static async add(
        domainId: string,
        type: 'provider' | 'node' | 'client',
        token: string,
    ): Promise<EdgeTokenDoc> {
        const now = new Date();
        const expireAt = new Date(now.getTime() + 30 * 60 * 1000); // 30分钟后过期
        
        const payload: EdgeTokenDoc = {
            _id: new ObjectId(),
            domainId,
            type,
            token,
            lastUsedAt: now,
            createdAt: now,
            expireAt,
        };
        
        await EdgeTokenModel.coll.insertOne(payload);
        return payload;
    }

    static async getByToken(token: string): Promise<EdgeTokenDoc | null> {
        const doc = await EdgeTokenModel.coll.findOne({ token });
        if (!doc) return null;
        
        // 检查是否过期（30分钟未使用）
        const now = new Date();
        if (doc.expireAt < now) {
            // 已过期，删除
            await EdgeTokenModel.coll.deleteOne({ _id: doc._id });
            return null;
        }
        
        return doc as EdgeTokenDoc;
    }

    static async updateLastUsed(token: string): Promise<void> {
        const now = new Date();
        const expireAt = new Date(now.getTime() + 30 * 60 * 1000); // 重置过期时间为30分钟后
        
        await EdgeTokenModel.coll.updateOne(
            { token },
            {
                $set: {
                    lastUsedAt: now,
                    expireAt,
                },
            },
        );
    }

    static async delete(token: string): Promise<void> {
        await EdgeTokenModel.coll.deleteOne({ token });
    }

    static async deleteByDomain(domainId: string, type?: 'provider' | 'node' | 'client'): Promise<void> {
        const filter: Filter<EdgeTokenDoc> = { domainId };
        if (type) {
            filter.type = type;
        }
        await EdgeTokenModel.coll.deleteMany(filter);
    }

    // 清理过期的 token（定时任务）
    static async cleanExpired(): Promise<number> {
        const now = new Date();
        const result = await EdgeTokenModel.coll.deleteMany({
            expireAt: { $lt: now },
        });
        return result.deletedCount || 0;
    }
}

export async function apply(ctx: Context) {
    await ctx.db.ensureIndexes(
        EdgeTokenModel.coll,
        { key: { token: 1 }, name: 'token', unique: true },
        { key: { domainId: 1, type: 1 }, name: 'domain_type' },
        { key: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
    );

    // 定期清理过期 token（每5分钟执行一次）
    setInterval(async () => {
        try {
            const deleted = await EdgeTokenModel.cleanExpired();
            if (deleted > 0) {
                const logger = new (await import('../logger')).Logger('edge_token');
                logger.debug('Cleaned up %d expired tokens', deleted);
            }
        } catch (e) {
            // ignore
        }
    }, 5 * 60 * 1000);
}

export default EdgeTokenModel;

