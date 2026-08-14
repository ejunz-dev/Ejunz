import { Fragment, type ReactNode } from 'react';
import { usePageData } from '../context/page-data';
import { Button, Callout, Card, List, ListItem, Tag } from '../components';
import { HitokotoWidget, SuggestionWidget } from '../components/homepage';
import { i18n } from '../i18n';
import './homepage.css';

type Udict = Record<string, { uname?: string }>;

const text = (value: unknown) => String(value ?? '');
const formatTime = (value: unknown) => {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(+date) ? '' : date.toLocaleString();
};
const userName = (udict: Udict, uid?: number) => (uid == null ? '' : udict[String(uid)]?.uname || `#${uid}`);

function StatTriple({ value }: { value?: { nodes?: number; cards?: number; problems?: number } }) {
  const parts = [value?.nodes ?? 0, value?.cards ?? 0, value?.problems ?? 0];
  const colors = ['#60a5fa', '#4ade80', '#fbbf24'];
  return (
    <span className="uix-triple">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i ? <span className="uix-muted"> / </span> : null}
          <span style={{ color: colors[i] }}>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

function AccessGate({ payload, children }: { payload: any; children: ReactNode }) {
  if (payload?.needLogin) {
    return (
      <div className="uix-gate">
        <p className="uix-muted">{i18n('Please login to view')}</p>
        <Button to="user_login" variant="primary">{i18n('Login')}</Button>
      </div>
    );
  }
  if (payload?.needJoinDomain) {
    return (
      <div className="uix-gate">
        <p className="uix-muted">{i18n('Please join the domain to view')}</p>
        <Button to="domain_join" variant="primary">{i18n('Join Domain')}</Button>
      </div>
    );
  }
  return children;
}

function Ranking({ title, payload, udict }: { title: string; payload: any; udict: Udict }) {
  const rows = payload?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  return (
    <Card title={title}>
      <div className="uix-rank uix-rank--head uix-muted">
        <span>{i18n('User')}</span>
        <span style={{ textAlign: 'center' }}>N / C / P</span>
        <span style={{ textAlign: 'right' }}>{i18n('Rating')}</span>
      </div>
      {rows.map((row: any) => {
        const rating = Number(row.rating ?? 1);
        const color = rating > 1 ? '#4ade80' : rating < 1 ? '#f87171' : 'inherit';
        return (
          <div className="uix-rank" key={row.uid}>
            <span className="uix-rank__user">
              {row.rank != null ? <span className="uix-muted">{row.rank}. </span> : null}
              {userName(udict, row.uid)}
            </span>
            <span style={{ textAlign: 'center' }}><StatTriple value={row} /></span>
            <span style={{ textAlign: 'right', fontWeight: 600, color }}>{rating.toFixed(2)}</span>
          </div>
        );
      })}
    </Card>
  );
}

function groupNodes(value: unknown): [string, any[]][] {
  if (!value || typeof value !== 'object') return [];
  const group = (items: any[]) => {
    const groups = new Map<string, any[]>();
    for (const node of items) {
      const key = text(node?.content || i18n('Other'));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node);
    }
    return [...groups.entries()];
  };
  if (Array.isArray(value)) return group(value);
  const entries = Object.entries(value as Record<string, any>);
  if (entries.length && entries.every(([, item]) => Array.isArray(item))) return entries as [string, any[]][];
  return group(entries.map(([, item]) => item));
}

function renderSection(name: string, payload: unknown, udict: Udict, domain: { bulletin?: string }): ReactNode {
  if (name === 'hitokoto') return <HitokotoWidget />;
  if (name === 'suggestion') return <SuggestionWidget />;
  if (name === 'bulletin') {
    return domain.bulletin ? (
      <section className="uix-card uix-bulletin-widget">
        <div className="uix-card__body uix-bulletin">{domain.bulletin}</div>
      </section>
    ) : null;
  }
  if (name === 'error') {
    return <Callout type="warn" title={i18n('Request failed')}>{text(payload)}</Callout>;
  }
  if (name === 'base') {
    const items = Array.isArray(payload) ? payload : [];
    if (!items.length) return null;
    return (
      <Card title={i18n('Recent Bases')}>
        <List>
          {items.map((item: any) => (
            <ListItem
              key={item.docId}
              to="base_detail"
              params={{ docId: item.docId }}
              title={item.title || i18n('Untitled')}
              meta={formatTime(item.updateAt)}
            />
          ))}
        </List>
      </Card>
    );
  }
  if (name === 'agent') {
    const items = Array.isArray(payload) ? payload : [];
    if (!items.length) return null;
    return (
      <Card title={i18n('Agent')}>
        <List>
          {items.map((item: any) => (
            <ListItem
              key={item.aid}
              to="agent_detail"
              params={{ aid: item.aid }}
              title={item.title || i18n('Untitled')}
              meta={formatTime(item.updateAt)}
            />
          ))}
        </List>
      </Card>
    );
  }
  if (name === 'checkin' && payload) {
    const data = payload as any;
    const body = (
      <div className="uix-checkin">
        <span className="uix-stat">
          <a href={data.learnUrl || '#'}><strong>{data.learnDays ?? 0}</strong></a>
          <span className="uix-muted"> {i18n('days')}</span>
        </span>
        {data.learnTodayDone
          ? <span className="uix-ok">{i18n('Checked in')}</span>
          : <span className="uix-muted">{i18n('{0} more cards to go', data.learnTodayRemaining)}</span>}
      </div>
    );
    return (
      <Card title={i18n('Check-in Days')} description={data.userUname ? text(data.userUname) : undefined}>
        <AccessGate payload={data}>{body}</AccessGate>
      </Card>
    );
  }
  if (name === 'today_domain_stats' && payload) {
    const data = payload as any;
    const body = (
      <>
        <div className="uix-kv"><span>{i18n('Content contribution')}</span><StatTriple value={data.contribution} /></div>
        <div className="uix-kv"><span>{i18n('Learning consumption')}</span><StatTriple value={data.consumption} /></div>
        <div className="uix-muted" style={{ fontSize: '0.75rem' }}>{i18n('Content')}</div>
      </>
    );
    return (
      <Card title={i18n("Today's domain activity")} description={data.date ? `UTC ${text(data.date)}` : undefined}>
        <AccessGate payload={data}>{body}</AccessGate>
      </Card>
    );
  }
  if (name === 'discussion') {
    const docs = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
    if (!docs.length) return null;
    return (
      <Card title={i18n('Discussion')}>
        <List>
          {docs.map((item: any) => (
            <ListItem
              key={item.docId}
              to="discussion_detail"
              params={{ did: item.docId }}
              title={item.title || i18n('Untitled')}
              meta={`${item.nReply != null ? `${item.nReply} replies · ` : ''}${userName(udict, item.owner)}`}
            />
          ))}
        </List>
        <div style={{ marginTop: '0.5rem' }}>
          <Tag to="discussion_main" className="uix-muted">{i18n('More')} →</Tag>
        </div>
      </Card>
    );
  }
  if (name === 'contribution_ranking') return <Ranking title={i18n('Contribution ranking')} payload={payload} udict={udict} />;
  if (name === 'consumption_ranking') return <Ranking title={i18n('Consumption ranking')} payload={payload} udict={udict} />;
  if (name === 'discussion_nodes') {
    const groups = groupNodes(payload);
    return (
      <Card title={i18n('Discussion Nodes')}>
        {groups.map(([category, nodes]) => (
          <div className="uix-nodegroup" key={category}>
            <div className="uix-nodegroup__title">{category}</div>
            <div className="uix-chips">
              {nodes.map((node: any, index: number) => {
                const nodeId = String(node?.docId ?? node?._id ?? '');
                if (!nodeId) return null;
                return <Tag to="discussion_node" params={{ type: 'node', name: nodeId }} key={`${nodeId}-${index}`}>{nodeId}</Tag>;
              })}
            </div>
          </div>
        ))}
      </Card>
    );
  }
  return <Callout type="warn" title={i18n('Request failed')}>{i18n('Template {0} not found.', name)}</Callout>;
}

export default function Homepage() {
  const { args } = usePageData();
  const contents = Array.isArray(args.contents) ? args.contents : [];
  const udict = (args.udict || {}) as Udict;
  const domain = (args.domain || {}) as { bulletin?: string };
  return (
    <div className="uix-home">
      <div className="uix-home__columns">
        {contents.map((column: any, i) => (
          <div key={i} className="uix-home__column" style={{ gridColumn: `span ${column.width || 12}` }}>
            {(column.sections || []).map(([name, payload]: [string, unknown], j: number) => (
              <Fragment key={j}>{renderSection(name, payload, udict, domain)}</Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
