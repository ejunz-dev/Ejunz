import type { ReactNode } from 'react';
import { Link } from '../components';
import { usePageData } from '../context/page-data';
import { i18n } from '../i18n';
import './domain-manage-layout.css';

const groups = [
  {
    title: 'Properties',
    items: [
      ['domain_dashboard', 'domain_dashboard'],
      ['domain_edit', 'domain_edit'],
      ['domain_join_applications', 'domain_join_applications'],
    ],
  },
  {
    title: 'Access Control',
    items: [
      ['domain_role', 'domain_role'],
      ['domain_user', 'domain_user'],
      ['domain_permission', 'domain_permission'],
      ['domain_group', 'domain_group'],
    ],
  },
];

export function DomainManageLayout({ children }: { children: ReactNode }) {
  const { name, template } = usePageData();
  const active = (typeof template === 'string' ? template.replace(/\.html$/, '') : '') || name;
  return (
    <div className="uix-domain-manage">
      <section className="uix-domain-manage__content">{children}</section>
      <aside className="uix-domain-manage__sidebar" aria-label={i18n('Domain management')}>
        {groups.map((group) => (
          <section className="uix-domain-manage__group" key={group.title}>
            <h2>{i18n(group.title)}</h2>
            <nav>
              {group.items.map(([route, label]) => (
                <Link key={route} to={route} className={`uix-domain-manage__link${active === route ? ' is-active' : ''}`} aria-current={active === route ? 'page' : undefined}>
                  {i18n(label)}
                </Link>
              ))}
            </nav>
          </section>
        ))}
      </aside>
    </div>
  );
}
