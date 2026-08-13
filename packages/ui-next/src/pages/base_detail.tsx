import { useMemo } from 'react';
import { usePageData } from '../context/page-data';
import { useBuildUrl } from '../hooks/use-build-url';
import { BaseDetailApp } from '../base-detail/BaseDetailApp';
import type { BaseDetailDomContext } from '../base-detail/types';
import '../base-detail/base-detail.css';

const escapeHtml = (value: unknown) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const buildLink = (url: string, content: string, attrs: Record<string, string> = {}) => {
  const safeAttrs = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join('');
  const client = url.startsWith('/') && !url.startsWith('//') ? ' data-ej-link="1"' : '';
  return `<a href="${escapeHtml(url)}"${client}${safeAttrs}>${content}</a>`;
};

export default function BaseDetailPage() {
  const { args, url } = usePageData();
  const buildUrl = useBuildUrl();
  const ctx = useMemo<BaseDetailDomContext>(() => ({
    args: args as Record<string, any>,
    page: { url },
    escape: escapeHtml,
    buildUrl,
    link: buildLink,
  }), [args, url, buildUrl]);
  return <BaseDetailApp ctx={ctx} />;
}
