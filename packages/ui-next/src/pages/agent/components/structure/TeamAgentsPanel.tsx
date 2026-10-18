import { useMemo, useState } from 'react';
import { Button } from '@ejunz/ui-next';
import type { AgentSummary, AgentTeam, AgentTeamRole } from '../../runtime/session';
import { i18n } from '@/i18n';
import styles from './TeamAgentsPanel.module.css';

interface Props {
    team: AgentTeam;
    teams: readonly AgentTeam[];
    agents: readonly AgentSummary[];
    roles: readonly AgentTeamRole[];
    savingAgentId?: string | null;
    onCreateAgent: () => void;
    onRoleChange: (agentId: string, roleId: string | null) => Promise<void>;
}

export function TeamAgentsPanel({ team, teams, agents, roles, savingAgentId, onCreateAgent, onRoleChange }: Props) {
    const [error, setError] = useState('');
    const groupAgents = useMemo(() => agents.filter((agent) => agent.groupId === team.groupId), [agents, team.groupId]);
    const teamNames = useMemo(() => new Map(teams.map((item) => [item.teamId, item.text])), [teams]);
    const defaultRole = team.config?.acl?.roles.find((role) => role.roleId === team.config?.acl?.activeRoleId)?.name || i18n('Default');

    return (
        <div className={styles.panel}>
            <header className={styles.header}>
                <div>
                    <h3>{i18n('Agents')}</h3>
                    <p>{i18n('Manage Agents in this Group and assign each one a role.')}</p>
                </div>
                <Button variant="primary" onClick={onCreateAgent}>{i18n('Create Agent')}</Button>
            </header>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.tableWrap}>
                <table className={styles.table}>
                    <thead><tr><th>{i18n('Agent')}</th><th>{i18n('Team')}</th><th>{i18n('Role')}</th></tr></thead>
                    <tbody>
                        {groupAgents.map((agent) => {
                            const assignedRoleId = roles.some((role) => role.roleId === agent.settings.roleId) ? agent.settings.roleId || '' : '';
                            return <tr key={agent.agentId}>
                                <td>
                                    <strong>{agent.title}</strong>
                                    <small>{agent.agentId}</small>
                                </td>
                                <td>{teamNames.get(agent.teamId) || agent.teamId}</td>
                                <td>
                                    <select
                                        value={assignedRoleId}
                                        disabled={savingAgentId === agent.agentId}
                                        aria-label={`${agent.title} ${i18n('Role')}`}
                                        onChange={(event) => {
                                            setError('');
                                            void onRoleChange(agent.agentId, event.target.value || null).catch((failure) => {
                                                setError(failure instanceof Error ? failure.message : String(failure));
                                            });
                                        }}
                                    >
                                        <option value="">{i18n('Inherit group role: {0}', defaultRole)}</option>
                                        {roles.map((role) => <option key={role.roleId} value={role.roleId}>{i18n(role.name)}</option>)}
                                    </select>
                                </td>
                            </tr>;
                        })}
                        {!groupAgents.length ? <tr><td colSpan={3} className={styles.empty}>{i18n('No Agents in this Group yet.')}</td></tr> : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
