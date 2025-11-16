import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { ClientChatDoc } from '../interface';

const logger = new Logger('model/client_chat');

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: Date;
    toolName?: string;
    toolCallId?: string;
    responseTime?: number; // ms
    asrAudioPath?: string; // Path to ASR audio file (user recording)
    ttsAudioPath?: string; // Path to TTS audio file (AI response audio)
}

class ClientChatModel {
    static async add(
        domainId: string,
        clientId: number,
        owner: number,
        messages: ChatMessage[],
    ): Promise<ClientChatDoc> {
        const now = new Date();
        const messageCount = messages.length;
        
        const payload: Partial<ClientChatDoc> = {
            domainId,
            clientId,
            conversationId: await this.generateNextConversationId(domainId, clientId),
            messages,
            messageCount,
            createdAt: now,
            updatedAt: now,
            owner,
        };

        const docId = await document.add(
            domainId,
            `Client ${clientId} Chat ${payload.conversationId}`, // content
            owner,
            document.TYPE_CLIENT_CHAT,
            null,
            null,
            null,
            payload,
        );

        return await this.getByConversationId(domainId, clientId, payload.conversationId!) as ClientChatDoc;
    }

    static async generateNextConversationId(domainId: string, clientId: number): Promise<number> {
        const lastChat = await document.getMulti(domainId, document.TYPE_CLIENT_CHAT, { clientId })
            .sort({ conversationId: -1 })
            .limit(1)
            .project({ conversationId: 1 })
            .toArray();
        return ((lastChat[0] as any)?.conversationId || 0) + 1;
    }

    static async getByConversationId(
        domainId: string,
        clientId: number,
        conversationId: number,
    ): Promise<ClientChatDoc | null> {
        const chats = await document.getMulti(domainId, document.TYPE_CLIENT_CHAT, { 
            clientId, 
            conversationId 
        }).limit(1).toArray();
        return (chats[0] as ClientChatDoc) || null;
    }

    static async getByClientId(domainId: string, clientId: number): Promise<ClientChatDoc[]> {
        return await document.getMulti(domainId, document.TYPE_CLIENT_CHAT, { clientId })
            .sort({ conversationId: -1 })
            .toArray() as ClientChatDoc[];
    }

    static async getByOwner(domainId: string, owner: number): Promise<ClientChatDoc[]> {
        return await document.getMulti(domainId, document.TYPE_CLIENT_CHAT, { owner })
            .sort({ createdAt: -1 })
            .toArray() as ClientChatDoc[];
    }

    static async update(
        domainId: string,
        clientId: number,
        conversationId: number,
        update: Partial<ClientChatDoc>,
    ): Promise<ClientChatDoc> {
        const chat = await this.getByConversationId(domainId, clientId, conversationId);
        if (!chat) throw new Error('Chat not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_CLIENT_CHAT, chat.docId, $set) as ClientChatDoc;
    }

    static async addMessage(
        domainId: string,
        clientId: number,
        conversationId: number,
        message: ChatMessage,
    ): Promise<ClientChatDoc> {
        const chat = await this.getByConversationId(domainId, clientId, conversationId);
        if (!chat) throw new Error('Chat not found');
        
        const updatedMessages = [...(chat.messages || []), message];
        return await this.update(domainId, clientId, conversationId, {
            messages: updatedMessages,
            messageCount: updatedMessages.length,
        });
    }

    static async delete(
        domainId: string,
        clientId: number,
        conversationId: number,
    ): Promise<void> {
        const chat = await this.getByConversationId(domainId, clientId, conversationId);
        if (!chat) throw new Error('Chat not found');
        await document.deleteOne(domainId, document.TYPE_CLIENT_CHAT, chat.docId);
    }

    static async deleteByClientId(domainId: string, clientId: number): Promise<void> {
        await document.deleteMulti(domainId, document.TYPE_CLIENT_CHAT, { clientId });
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', async (domainId) => {
        await document.deleteMulti(domainId, document.TYPE_CLIENT_CHAT, {});
    });
}

export default ClientChatModel;

(global as any).Ejunz.model.clientChat = ClientChatModel;

