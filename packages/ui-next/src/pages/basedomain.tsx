import { useState } from 'react';
import { usePageData } from '../context/page-data';
import { Button, Card, Link, Tag } from '../components';
import './basedomain.css';

interface BaseItem {
  docId: string;
  title?: string;
  content?: string;
  updateAt?: string;
  tag?: string[];
}

const text = (value: unknown) => String(value ?? '');
const formatDate = (value: unknown) => {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(+date) ? '' : date.toLocaleDateString();
};
const snippet = (value: unknown) => {
  const plain = text(value).replace(/[#*_`>()[\]!-]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
};

export default function BaseDomain() {
  const { args } = usePageData();
  const bases = (Array.isArray(args.bases) ? args.bases : []) as BaseItem[];
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const filtered = q
    ? bases.filter((base) => `${base.title || ''} ${base.content || ''} ${(base.tag || []).join(' ')}`.toLowerCase().includes(q))
    : bases;

  return (
    <div className="uix-bases">
      <div className="uix-bases__toolbar">
        <input
          className="uix-bases__search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search bases"
        />
        <Button to="base_create" variant="primary">Create Base</Button>
      </div>
      <div className="uix-bases__grid">
        {filtered.map((base) => (
          <Card key={base.docId} title={base.title || 'Untitled'} to="base_detail" params={{ docId: base.docId }}>
            <p className="uix-base-card__snippet">{snippet(base.content)}</p>
            <div className="uix-bases__card-footer">
              <span className="uix-bases__tags">
                {(base.tag || []).map((tag) => <Tag key={tag}>{tag}</Tag>)}
              </span>
              <span className="uix-muted">{formatDate(base.updateAt)}</span>
            </div>
          </Card>
        ))}
        {!filtered.length ? <div className="uix-muted">No bases found.</div> : null}
      </div>
      <p className="uix-muted" style={{ marginTop: '1rem' }}>
        <Link to="homepage">Back to homepage</Link>
      </p>
    </div>
  );
}
