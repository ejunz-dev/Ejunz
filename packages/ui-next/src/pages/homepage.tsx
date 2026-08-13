import { Fragment, type ReactNode } from 'react';
import { usePageData } from '../context/page-data';
import { useBuildUrl } from '../hooks/use-build-url';
import { Link } from '../components/link';
import './homepage.css';

type Udict = Record<string, { uname?: string }>;

const text = (value: unknown) => String(value ?? '');
const formatTime = (value: unknown) => {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(+date) ? '' : date.toLocaleString();
};
const userName = (udict: Udict, uid?: number) => (uid == null ? '' : udict[String(uid)]?.uname || `#${uid}`);

function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="uinp-card">
      <div className="uinp-card__header">
        <h2 className="uinp-card__title">{title}</h2>
        {description ? <p className="uinp-card__desc">{description}</p> : null}
      </div>
      <div className="uinp-card__body">{children}</div>
    </section>
  );
}

function ListRow({ to, params, title, meta }: { to: string; params?: Record<string, string>; title: string; meta?: ReactNode }) {
  return (
    <li className="uinp-list__item">
      <Link to={to} params={params} className="uinp-list__title">{title}</Link>
      {meta != null ? <span className="uinp-muted">{meta}</span> : null}
    </li>
  );
}

function StatTriple({ value }: { value?: { nodes?: number; cards?: number; problems?: number } }) {
  const parts = [value?.nodes ?? 0, value?.cards ?? 0, value?.problems ?? 0];
  const colors = ['#60a5fa', '#4ade80', '#fbbf24'];
  return (
    <span className="uinp-triple">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i ? <span className="uinp-muted"> / </span> : null}
          <span style={{ color: colors[i] }}>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

function AccessGate({ payload, children }: { payload: any; children: ReactNode }) {
  if (payload?.needLogin) {
    return (
      <div className="uinp-gate">
        <p className="uinp-muted">Please login to view</p>
        <Link to="user_login" className="uinp-button uinp-button--primary">Login</Link>
      </div>
    );
  }
  if (payload?.needJoinDomain) {
    return (
      <div className="uinp-gate">
        <p className="uinp-muted">Please join the domain to view</p>
        <Link to="domain_join" className="uinp-button uinp-button--primary">Join Domain</Link>
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
      <div className="uinp-rank uinp-rank--head uinp-muted">
        <span>User</span>
        <span style={{ textAlign: 'center' }}>N / C / P</span>
        <span style={{ textAlign: 'right' }}>Rating</span>
      </div>
      {rows.map((row: any) => {
        const rating = Number(row.rating ?? 1);
        const color = rating > 1 ? '#4ade80' : rating < 1 ? '#f87171' : 'inherit';
        return (
          <div className="uinp-rank" key={row.uid}>
            <span className="uinp-rank__user">
              {row.rank != null ? <span className="uinp-muted">{row.rank}. </span> : null}
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
      const key = text(node?.content || 'Other');
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

function renderSection(name: string, payload: unknown, udict: Udict, buildUrl: (n: string, p?: Record<string, string>) => string): ReactNode {
  if (name === 'bulletin') return null;
  if (name === 'error') {
    return (
      <div className="uinp-callout uinp-callout--warn" role="alert">
        <strong>Section failed to load</strong>
        <p className="uinp-muted">{text(payload)}</p>
      </div>
    );
  }
  if (name === 'base') {
    const items = Array.isArray(payload) ? payload : [];
    if (!items.length) return null;
    return (
      <Card title="Recent Bases">
        <ul className="uinp-list">
          {items.map((item: any) => (
            <ListRow
              key={item.docId}
              to="base_detail"
              params={{ docId: item.docId }}
              title={item.title || 'Untitled'}
              meta={formatTime(item.updateAt)}
            />
          ))}
        </ul>
      </Card>
    );
  }
  if (name === 'agent') {
    const items = Array.isArray(payload) ? payload : [];
    if (!items.length) return null;
    return (
      <Card title="Agent">
        <ul className="uinp-list">
          {items.map((item: any) => (
            <ListRow
              key={item.aid}
              to="agent_detail"
              params={{ aid: item.aid }}
              title={item.title || 'Untitled'}
              meta={formatTime(item.updateAt)}
            />
          ))}
        </ul>
      </Card>
    );
  }
  if (name === 'checkin' && payload) {
    const data = payload as any;
    const body = (
      <div className="uinp-checkin">
        <span className="uinp-stat">
          <a href={data.learnUrl || '#'}><strong>{data.learnDays ?? 0}</strong></a>
          <span className="uinp-muted"> days</span>
        </span>
        {data.learnTodayDone
          ? <span className="uinp-ok">Checked in</span>
          : <span className="uinp-muted">{data.learnTodayRemaining} more cards to go</span>}
      </div>
    );
    return (
      <Card title="Check-in Days" description={data.userUname ? text(data.userUname) : undefined}>
        <AccessGate payload={data}>{body}</AccessGate>
      </Card>
    );
  }
  if (name === 'today_domain_stats' && payload) {
    const data = payload as any;
    const body = (
      <>
        <div className="uinp-kv"><span>Content contribution</span><StatTriple value={data.contribution} /></div>
        <div className="uinp-kv"><span>Learning consumption</span><StatTriple value={data.consumption} /></div>
        <div className="uinp-muted" style={{ fontSize: '0.75rem' }}>Nodes / Cards / Problems</div>
      </>
    );
    return (
      <Card title="Today's domain activity" description={data.date ? `UTC ${text(data.date)}` : undefined}>
        <AccessGate payload={data}>{body}</AccessGate>
      </Card>
    );
  }
  if (name === 'discussion') {
    const docs = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
    if (!docs.length) return null;
    return (
      <Card title="Discussion">
        <ul className="uinp-list">
          {docs.map((item: any) => (
            <ListRow
              key={item.docId}
              to="discussion_detail"
              params={{ did: item.docId }}
              title={item.title || 'Untitled'}
              meta={`${item.nReply != null ? `${item.nReply} replies · ` : ''}${userName(udict, item.owner)}`}
            />
          ))}
        </ul>
        <div style={{ marginTop: '0.5rem' }}>
          <Link to="discussion_main" className="uinp-muted">More →</Link>
        </div>
      </Card>
    );
  }
  if (name === 'contribution_ranking') return <Ranking title="Contribution ranking" payload={payload} udict={udict} />;
  if (name === 'consumption_ranking') return <Ranking title="Consumption ranking" payload={payload} udict={udict} />;
  if (name === 'discussion_nodes') {
    const groups = groupNodes(payload);
    if (!groups.length) return null;
    return (
      <Card title="Discussion Nodes">
        {groups.map(([category, nodes]) => (
          <div className="uinp-nodegroup" key={category}>
            <div className="uinp-nodegroup__title">{category}</div>
            <div className="uinp-chips">
              {nodes.map((node: any) => (
                <Link to="discussion_node" params={{ type: 'node', name: node.docId }} className="uinp-tag" key={node.docId}>
                  {node.docId}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </Card>
    );
  }
  return null;
}

export default function Homepage() {
  const { args } = usePageData();
  const buildUrl = useBuildUrl();
  const contents = Array.isArray(args.contents) ? args.contents : [];
  const udict = (args.udict || {}) as Udict;
  const domain = (args.domain || {}) as { bulletin?: string };
  return (
    <div className="uinp-home">
      {domain.bulletin ? <div className="uinp-bulletin">{domain.bulletin}</div> : null}
      <div className="uinp-home__columns">
        {contents.map((column: any, i) => (
          <div key={i} className="uinp-home__column" style={{ gridColumn: `span ${column.width || 12}` }}>
            {(column.sections || []).map(([name, payload]: [string, unknown], j: number) => (
              <Fragment key={j}>{renderSection(name, payload, udict, buildUrl)}</Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
