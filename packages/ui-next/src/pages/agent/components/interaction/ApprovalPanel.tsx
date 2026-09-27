import { useState } from 'react';
import type { PendingApproval } from '../types';
import css from './ApprovalPanel.module.css';

interface ApprovalPanelProps {
    approval: PendingApproval;
    onAnswer: (outcome: 'allowed-once' | 'rejected') => Promise<void>;
}

export function ApprovalPanel({ approval, onAnswer }: ApprovalPanelProps) {
    const [busy, setBusy] = useState(false);
    const answer = async (outcome: 'allowed-once' | 'rejected') => {
        setBusy(true);
        try {
            await onAnswer(outcome);
        } catch {
            setBusy(false);
        }
    };
    return <div className={css.root} data-approval-key={approval.approvalId}>
        <div className={css.card}>
            <div className={css.strip}><span className={css.dot} />等待操作确认</div>
            <div className={css.body} tabIndex={0} role="group" aria-label="审批详情">
                <div className={css.headline}>{approval.reason || `Agent 请求执行 ${approval.toolName}`}</div>
                <div className={css.command}>{approval.toolName}</div>
            </div>
            <div className={css.actionRow}>
                <button type="button" className={css.reject} disabled={busy} onClick={() => void answer('rejected')}>拒绝</button>
                <button type="button" disabled={busy} onClick={() => void answer('allowed-once')}>允许一次</button>
            </div>
        </div>
    </div>;
}
