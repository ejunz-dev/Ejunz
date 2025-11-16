import {
    DetailType, type LangConfig,
} from '@ejunz/common';

export interface Session {
    getLang: (name: string, doThrow?: boolean) => LangConfig;
    getReporter: (task: any) => { next: () => void, end: () => void };
    fetchFile: <T extends null | string>(namespace: T, files: Record<string, string>) => Promise<T extends null ? string : null>;
    postFile: (target: string, filename: string, file: string) => Promise<void>;
    config: { detail: DetailType, host?: string, trusted?: boolean };
}
