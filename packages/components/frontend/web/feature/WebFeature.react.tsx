import React from 'react';

export interface WebFeatureProps {
  title: string;
  description?: string;
  href?: string;
  /** Optional link component (e.g. next/link). Defaults to `<a>`. */
  LinkComponent?: React.ElementType;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Ejunz Web 首页入口卡。
 * DOM/样式对齐 docs.ejunz.com：外层卡片 + 标题链接 + 附加内容（如 GithubInfo）。
 */
export function WebFeature({
  title,
  description,
  href,
  LinkComponent,
  className = '',
  children,
}: WebFeatureProps) {
  const classes = ['ej-web-feature', 'group', className].filter(Boolean).join(' ');
  const heading = (
    <>
      <h3 className="ej-web-feature__title">{title}</h3>
      {description ? <p className="ej-web-feature__desc">{description}</p> : null}
    </>
  );

  let head: React.ReactNode = heading;
  if (href) {
    const L = LinkComponent || 'a';
    head = (
      <L href={href} className="ej-web-feature__link">
        {heading}
      </L>
    );
  }

  return (
    <div className={classes}>
      {head}
      {children}
    </div>
  );
}

export default WebFeature;
