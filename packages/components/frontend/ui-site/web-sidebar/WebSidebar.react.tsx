import React from 'react';

export type WebSidebarItem = {
  key: string;
  title: string;
  href?: string;
  active?: boolean;
};

export type WebSidebarGroup = {
  title: string;
  items: WebSidebarItem[];
};

export interface WebSidebarProps {
  groups: WebSidebarGroup[];
  /** Optional top banner (RootToggle / SearchTrigger / etc). */
  banner?: React.ReactNode;
  /** Optional header link above groups. */
  header?: { title: string; href?: string; active?: boolean };
  /** Custom link component (react-router Link / next/link). Defaults to `<a>`. */
  LinkComponent?: React.ElementType;
  onNavigate?: (item: WebSidebarItem) => void;
  className?: string;
  'aria-label'?: string;
}

/** Docs-style sidebar: optional banner + categorized nav. */
export function WebSidebar({
  groups,
  banner,
  header,
  LinkComponent,
  onNavigate,
  className = '',
  'aria-label': ariaLabel = 'Sidebar',
}: WebSidebarProps) {
  const L = LinkComponent || 'a';

  const renderLink = (
    item: { title: string; href?: string; active?: boolean; key?: string },
    classNameItem: string,
  ) => {
    const classes = [classNameItem, item.active ? 'is-active' : ''].filter(Boolean).join(' ');
    const content = item.title;
    if (item.href) {
      return (
        <L
          href={item.href}
          to={item.href}
          className={classes}
          onClick={() => {
            if (item.key != null) onNavigate?.({ key: item.key, title: item.title, href: item.href, active: item.active });
          }}
        >
          {content}
        </L>
      );
    }
    return (
      <button
        type="button"
        className={classes}
        onClick={() => {
          if (item.key != null) onNavigate?.({ key: item.key, title: item.title, href: item.href, active: item.active });
        }}
      >
        {content}
      </button>
    );
  };

  return (
    <aside
      className={['ej-web-sidebar', className].filter(Boolean).join(' ')}
      aria-label={ariaLabel}
    >
      {banner ? <div className="ej-web-sidebar__banner">{banner}</div> : null}
      {header ? (
        <div className="ej-web-sidebar__header">
          {renderLink(header, 'ej-web-sidebar__header-link')}
        </div>
      ) : null}
      <nav className="ej-web-sidebar__nav">
        {groups.map((group) => (
          <div key={group.title} className="ej-web-sidebar__group">
            <p className="ej-web-sidebar__label">{group.title}</p>
            <ul className="ej-web-sidebar__list">
              {group.items.map((item) => (
                <li key={item.key}>
                  {renderLink(item, 'ej-web-sidebar__item')}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export default WebSidebar;
