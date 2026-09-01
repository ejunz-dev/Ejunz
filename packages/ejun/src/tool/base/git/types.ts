export interface BaseGitInput {
    domainId: string;
    baseDocId: number;
    owner: number;
    ownerName?: string;
    setting?: { get: (k: string) => unknown };
    githubToken?: string;
    commitMessage?: string;
}
