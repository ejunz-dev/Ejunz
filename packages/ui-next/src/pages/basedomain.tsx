import { useState } from 'react';
import { usePageData } from '../context/page-data';
import { Link } from '../components/link';
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
    <div className="uinp-bases">
      <div className="uinp-bases__toolbar">
        <input
          className="uinp-bases__search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search bases"
        />
        <Link to="base_create" className="uinp-button uinp-button--primary">Create Base</Link>
      </div>
      <div className="uinp-bases__grid">
        {filtered.map((base) => (
          <div key={base.docId} className="uinp-base-card">
            <h3 className="uinp-base-card__title">
              <Link to="base_detail" params={{ docId: base.docId }}>{base.title || 'Untitled'}</Link>
            </h3>
            <p className="uinp-base-card__snippet">{snippet(base.content)}</p>
            <div className="uinp-bases__card-footer">
              <span className="uinp-bases__tags">
                {(base.tag || []).map((tag) => <span key={tag} className="uinp-tag">{tag}</span>)}
              </span>
              <span className="uinp-muted">{formatDate(base.updateAt)}</span>
            </div>
          </div>
        ))}
        {!filtered.length ? <div className="uinp-muted">No bases found.</div> : null}
      </div>
      <p className="uinp-muted" style={{ marginTop: '1rem' }}>
        <Link to="homepage">Back to homepage</Link>
      </p>
    </div>
  );
}
