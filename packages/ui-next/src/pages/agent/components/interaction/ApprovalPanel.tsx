import { useState } from 'react';
import { i18n } from '@/i18n';
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
            <div className={css.strip}><span className={css.dot} />{i18n('Waiting for approval')}</div>
            <div className={css.body} tabIndex={0} role="group" aria-label={i18n('Approval details')}>
                <div className={css.headline}>{approval.reason || i18n('Agent requested to run {0}', approval.toolName)}</div>
                <div className={css.command}>{approval.toolName}</div>
            </div>
            <div className={css.actionRow}>
                <button type="button" className={css.reject} disabled={busy} onClick={() => void answer('rejected')}>{i18n('Reject')}</button>
                <button type="button" disabled={busy} onClick={() => void answer('allowed-once')}>{i18n('Allow once')}</button>
            </div>
        </div>
    </div>;
}
