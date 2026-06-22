import React, { useCallback, useEffect, useState } from 'react';
import Notification from 'vj/components/notification';
import { request, domainApiPath } from 'vj/utils';
import type { EditorThemeStyles } from 'vj/components/editor_workspace';
import { roadmapApiPath } from './shared';

function roadmapBranchEditUrl(domainId: string, docId: string, branch: string): string {
  return domainApiPath(`/roadmap/${docId}/branch/${encodeURIComponent(branch)}/edit`, domainId);
}

function RoadmapGitHubRailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export { RoadmapGitHubRailIcon };

export interface RoadmapGitPanelProps {
  domainId: string;
  docId: string;
  currentBranch: string;
  branches: string[];
  themeStyles: EditorThemeStyles;
  onPullComplete?: () => Promise<void> | void;
  onBranchesChange?: (branches: string[]) => void;
}

export function RoadmapGitPanel({
  domainId,
  docId,
  currentBranch,
  branches,
  themeStyles,
  onPullComplete,
  onBranchesChange,
}: RoadmapGitPanelProps) {
  const ui = (window as any).UiContext || {};
  const [gitRepoDraft, setGitRepoDraft] = useState(String(ui.githubRepo || ''));
  const [gitTokenDraft, setGitTokenDraft] = useState('');
  const [githubPATConfigured, setGithubPATConfigured] = useState(!!ui.userGithubTokenConfigured);
  const [gitRemoteStatus, setGitRemoteStatus] = useState<any>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitCommitNote, setGitCommitNote] = useState('');
  const [gitActionBusy, setGitActionBusy] = useState<'commit' | 'pull' | 'push' | null>(null);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchList, setBranchList] = useState(branches);

  useEffect(() => {
    setBranchList(branches);
  }, [branches]);

  const fetchGitRemoteStatus = useCallback(async () => {
    if (!docId) return;
    setGitStatusLoading(true);
    try {
      const res: any = await request.get(roadmapApiPath('/git/status', domainId), {
        docId: String(docId),
        branch: currentBranch || 'main',
      });
      setGitRemoteStatus(res?.gitStatus ?? null);
    } catch {
      setGitRemoteStatus(null);
    } finally {
      setGitStatusLoading(false);
    }
  }, [domainId, docId, currentBranch]);

  useEffect(() => {
    request.get(roadmapApiPath('/github/config', domainId), { docId: String(docId) }).then((r: any) => {
      if (r?.githubRepo != null) setGitRepoDraft(String(r.githubRepo));
    }).catch(() => {});
    fetchGitRemoteStatus();
    const t = setInterval(fetchGitRemoteStatus, 15000);
    return () => clearInterval(t);
  }, [domainId, docId, fetchGitRemoteStatus]);

  const btnStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderRadius: '4px',
    border: `1px solid ${themeStyles.borderSecondary}`,
    background: themeStyles.bgButton,
    color: themeStyles.textPrimary,
    cursor: 'pointer',
  };

  return (
    <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary }}>
      <div style={{ fontWeight: 600, color: themeStyles.textSecondary, marginBottom: '8px', padding: '0 8px' }}>
        GitHub · 分支 {currentBranch || 'main'}
      </div>

      <div style={{ marginBottom: '12px', padding: '0 8px' }}>
        <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: '6px' }}>分支切换</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {(branchList.length > 0 ? branchList : ['main']).map((branchName) => {
            const isCurrent = branchName === (currentBranch || 'main');
            return (
              <a
                key={branchName}
                href={isCurrent ? undefined : roadmapBranchEditUrl(domainId, docId, branchName)}
                onClick={isCurrent ? (e) => e.preventDefault() : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  borderRadius: '4px',
                  textDecoration: 'none',
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  backgroundColor: isCurrent ? themeStyles.bgSelected : themeStyles.bgButton,
                  color: isCurrent ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                  fontSize: '12px',
                  cursor: isCurrent ? 'default' : 'pointer',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {branchName}
                </span>
                <span style={{ fontSize: '11px', opacity: 0.85 }}>
                  {isCurrent ? '当前' : '切换'}
                </span>
              </a>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <input
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder="新分支名"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '6px 8px',
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '4px',
              background: themeStyles.bgPrimary,
              color: themeStyles.textPrimary,
              fontSize: '12px',
            }}
          />
          <button
            type="button"
            disabled={!newBranchName.trim()}
            onClick={async () => {
              const name = newBranchName.trim();
              if (!name) return;
              try {
                await request.post(roadmapApiPath('/branch', domainId), {
                  docId: Number(docId),
                  branch: name,
                  sourceBranch: currentBranch || 'main',
                });
                Notification.success(`已创建分支 ${name}`);
                const next = [...new Set([...branchList, name])];
                setBranchList(next);
                onBranchesChange?.(next);
                window.location.href = roadmapBranchEditUrl(domainId, docId, name);
              } catch (err: any) {
                Notification.error(err?.message || '创建分支失败');
              }
            }}
            style={{ ...btnStyle, flexShrink: 0 }}
          >
            新建
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 8px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>仓库 URL（HTTPS 或 git@…）</span>
          <input
            value={gitRepoDraft}
            onChange={(e) => setGitRepoDraft(e.target.value)}
            placeholder="https://github.com/org/repo"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px',
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '4px',
              background: themeStyles.bgPrimary,
              color: themeStyles.textPrimary,
            }}
          />
        </label>
        <button
          type="button"
          onClick={async () => {
            try {
              await request.post(roadmapApiPath('/github/config', domainId), {
                docId: Number(docId),
                githubRepo: gitRepoDraft.trim(),
              });
              if ((window as any).UiContext) (window as any).UiContext.githubRepo = gitRepoDraft.trim();
              Notification.success('已保存仓库配置');
              fetchGitRemoteStatus();
            } catch (err: any) {
              Notification.error(err?.message || '保存失败');
            }
          }}
          style={btnStyle}
        >
          保存仓库地址
        </button>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>
            个人访问令牌（PAT）{githubPATConfigured ? ' · 已配置' : ' · 未配置'}
          </span>
          <input
            type="password"
            value={gitTokenDraft}
            onChange={(e) => setGitTokenDraft(e.target.value)}
            placeholder="ghp_…"
            autoComplete="off"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px',
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '4px',
              background: themeStyles.bgPrimary,
              color: themeStyles.textPrimary,
            }}
          />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button
            type="button"
            onClick={async () => {
              try {
                await request.post(`/d/${domainId}/user/github-token`, { githubToken: gitTokenDraft.trim() });
                setGithubPATConfigured(!!gitTokenDraft.trim());
                setGitTokenDraft('');
                Notification.success('已保存令牌');
                fetchGitRemoteStatus();
              } catch (err: any) {
                Notification.error(err?.message || '保存失败');
              }
            }}
            style={btnStyle}
          >
            保存令牌
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await request.post(`/d/${domainId}/user/github-token`, { githubToken: '' });
                setGithubPATConfigured(false);
                setGitTokenDraft('');
                Notification.success('已清除令牌');
                fetchGitRemoteStatus();
              } catch (err: any) {
                Notification.error(err?.message || '清除失败');
              }
            }}
            style={{
              ...btnStyle,
              background: themeStyles.bgSecondary,
              color: themeStyles.textSecondary,
            }}
          >
            清除令牌
          </button>
        </div>
        <div
          style={{
            marginTop: '4px',
            padding: '8px',
            borderRadius: '4px',
            border: `1px solid ${themeStyles.borderSecondary}`,
            background: themeStyles.bgSecondary,
            fontSize: '11px',
          }}
        >
          {gitStatusLoading && !gitRemoteStatus ? (
            <span style={{ color: themeStyles.textSecondary }}>正在获取远程状态…</span>
          ) : gitRemoteStatus ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {(gitRemoteStatus.lastCommitShort || gitRemoteStatus.lastCommit) ? (
                <span style={{ wordBreak: 'break-all' }}>
                  当前分支最新提交：
                  {gitRemoteStatus.lastCommitShort || String(gitRemoteStatus.lastCommit).slice(0, 8)}
                  {gitRemoteStatus.lastCommitMessageShort || gitRemoteStatus.lastCommitMessage
                    ? ` — ${gitRemoteStatus.lastCommitMessageShort || gitRemoteStatus.lastCommitMessage}`
                    : ''}
                </span>
              ) : null}
              <span>相对 origin：领先 {gitRemoteStatus.ahead ?? 0} · 落后 {gitRemoteStatus.behind ?? 0}</span>
              <span>
                工作区相对最新提交：{gitRemoteStatus.uncommittedChanges ? '有未提交变更' : '干净'}
                {gitRemoteStatus.hasRemoteBranch === false ? ' · 远程无此分支' : ''}
              </span>
            </div>
          ) : (
            <span style={{ color: themeStyles.textSecondary }}>配置仓库与令牌后可查看与远程的差异</span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>本地 Git（先保存路线图再提交）</span>
          <input
            value={gitCommitNote}
            onChange={(e) => setGitCommitNote(e.target.value)}
            placeholder="提交说明（可选）"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px',
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '4px',
              background: themeStyles.bgPrimary,
              color: themeStyles.textPrimary,
              fontSize: '12px',
            }}
          />
          <button
            type="button"
            disabled={!!gitActionBusy}
            onClick={async () => {
              setGitActionBusy('commit');
              try {
                await request.post(
                  roadmapApiPath(`/branch/${encodeURIComponent(currentBranch || 'main')}/commit`, domainId),
                  { docId: Number(docId), note: gitCommitNote.trim() },
                );
                Notification.success('已提交到本地 Git 仓库');
                setGitCommitNote('');
                fetchGitRemoteStatus();
              } catch (err: any) {
                Notification.error(err?.message || '本地提交失败');
              } finally {
                setGitActionBusy(null);
              }
            }}
            style={{
              ...btnStyle,
              background: themeStyles.bgSecondary,
              alignSelf: 'flex-start',
              opacity: gitActionBusy ? 0.6 : 1,
              cursor: gitActionBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {gitActionBusy === 'commit' ? '提交中…' : '提交到本地仓库'}
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <button
            type="button"
            disabled={!!gitActionBusy}
            onClick={async () => {
              setGitActionBusy('pull');
              try {
                await request.post(
                  roadmapApiPath(`/branch/${encodeURIComponent(currentBranch || 'main')}/github/pull`, domainId),
                  { docId: Number(docId) },
                );
                Notification.success('Pull 完成');
                await onPullComplete?.();
                fetchGitRemoteStatus();
              } catch (err: any) {
                Notification.error(err?.message || 'Pull 失败');
              } finally {
                setGitActionBusy(null);
              }
            }}
            style={{
              padding: '6px 12px',
              borderRadius: '4px',
              border: 'none',
              background: themeStyles.bgButtonActive,
              color: themeStyles.textOnPrimary,
              cursor: gitActionBusy ? 'not-allowed' : 'pointer',
              opacity: gitActionBusy ? 0.6 : 1,
            }}
          >
            {gitActionBusy === 'pull' ? 'Pull…' : 'Pull'}
          </button>
          <button
            type="button"
            disabled={!!gitActionBusy}
            onClick={async () => {
              setGitActionBusy('push');
              try {
                await request.post(
                  roadmapApiPath(`/branch/${encodeURIComponent(currentBranch || 'main')}/github/push`, domainId),
                  { docId: Number(docId) },
                );
                Notification.success('Push 完成');
                fetchGitRemoteStatus();
              } catch (err: any) {
                Notification.error(err?.message || 'Push 失败');
              } finally {
                setGitActionBusy(null);
              }
            }}
            style={{
              ...btnStyle,
              opacity: gitActionBusy ? 0.6 : 1,
              cursor: gitActionBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {gitActionBusy === 'push' ? 'Push…' : 'Push'}
          </button>
          <button
            type="button"
            onClick={() => fetchGitRemoteStatus()}
            style={{
              ...btnStyle,
              background: themeStyles.bgSecondary,
              color: themeStyles.textSecondary,
            }}
          >
            刷新状态
          </button>
        </div>
      </div>
    </div>
  );
}
