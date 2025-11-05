import {
    BSON, Db, Filter, ObjectId, OnlyFieldsOfType,
} from 'mongodb';
import type { ConnectionHandler, Handler } from '@ejunz/framework';
import pm2 from '@ejunz/utils/lib/locate-pm2';
import { Context } from '../context';
import type {
    BaseUserDict, DiscussionDoc, DomainDoc, FileInfo,
    MessageDoc, User,
} from '../interface';
import type { DocType } from '../model/document';

export type Disposable = () => void;
export type VoidReturn = Promise<any> | any;

export interface EventMap {
    'app/listen': () => void;
    'app/started': () => void;
    'app/ready': () => VoidReturn;
    'app/exit': () => VoidReturn;
    'app/before-reload': (entries: Set<string>) => VoidReturn;
    'app/reload': (entries: Set<string>) => VoidReturn;

    'subscription/init': (h: ConnectionHandler<Context>, privileged: boolean) => VoidReturn;
    'subscription/subscribe': (channel: string, user: User, metadata: Record<string, string>) => VoidReturn;
    'subscription/enable': (
        channel: string, h: ConnectionHandler<Context>, privileged: boolean, onDispose: (disposable: () => void) => void,
    ) => VoidReturn;

    'app/watch/change': (path: string) => VoidReturn;
    'app/watch/unlink': (path: string) => VoidReturn;

    'database/connect': (db: Db) => void;
    'database/config': () => VoidReturn;

    'system/setting': (args: Record<string, any>) => VoidReturn;
    'system/setting-loaded': () => VoidReturn;
    'bus/broadcast': (event: keyof EventMap, payload: any, trace?: string) => VoidReturn;
    'monitor/update': (type: 'server' | 'judge', $set: any) => VoidReturn;
    'monitor/collect': (info: any) => VoidReturn;
    'api/update': () => void;
    'task/daily': () => void;
    'task/daily/finish': (pref: Record<string, number>) => void;

    'user/message': (uid: number[], mdoc: Omit<MessageDoc, 'to'>) => void;
    'user/get': (udoc: User) => void;
    'user/delcache': (content: string | true) => void;

    'user/import/parse': (payload: any) => VoidReturn;
    'user/import/create': (uid: number, udoc: any) => VoidReturn;

    'domain/create': (ddoc: DomainDoc) => VoidReturn;
    'domain/before-get': (query: Filter<DomainDoc>) => VoidReturn;
    'domain/get': (ddoc: DomainDoc) => VoidReturn;
    'domain/before-update': (domainId: string, $set: Partial<DomainDoc>) => VoidReturn;
    'domain/update': (domainId: string, $set: Partial<DomainDoc>, ddoc: DomainDoc) => VoidReturn;
    'domain/delete': (domainId: string) => VoidReturn;
    'domain/delete-cache': (domainId: string) => VoidReturn;

    'document/add': (doc: any) => VoidReturn;
    'document/set': <T extends keyof DocType>(
        domainId: string, docType: T, docId: DocType[T],
        $set: any, $unset: OnlyFieldsOfType<DocType[T], any, true | '' | 1>,
    ) => VoidReturn;

    'discussion/before-add': (payload: Partial<DiscussionDoc>) => VoidReturn;
    'discussion/add': (payload: Partial<DiscussionDoc>) => VoidReturn;

    'oplog/log': (type: string, handler: Handler<Context> | ConnectionHandler<Context>, args: any, data: any) => VoidReturn;
}

export function apply(ctx: Context) {
    try {
        if (!process.send || !pm2 || process.env.exec_mode !== 'cluster_mode') throw new Error('not in cluster mode');
        pm2.launchBus((err, bus) => {
            if (err) throw new Error('cannot launch pm2 bus');
            bus.on('ejunz:broadcast', (packet) => {
                (app.parallel as any)(packet.data.event, ...BSON.EJSON.parse(packet.data.payload));
            });
            ctx.on('bus/broadcast', (event, payload) => {
                process.send({ type: 'ejunz:broadcast', data: { event, payload: BSON.EJSON.stringify(payload) } });
            });
            console.debug('Using pm2 event bus');
        });
    } catch (e) {
        ctx.on('bus/broadcast', (event, payload) => app.parallel(event, ...payload));
        console.debug('Using mongodb external event bus');
    }
}

export default app;

global.bus = app;