import MarkdownIt from 'markdown-it';
import { Button, Card } from '../components';
import { usePageData, useUserContext } from '../context/page-data';
import { i18n } from '../i18n';
import './domain_dashboard.css';

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });

interface DomainInfo {
  _id?: string;
  name?: string;
  bulletin?: string;
  avatarUrl?: string;
}

interface OwnerInfo {
  _id?: number | string;
  uname?: string;
  avatarUrl?: string;
}

export default function DomainDashboard() {
  const { args } = usePageData();
  const user = useUserContext();
  const domain = (args.domain || {}) as DomainInfo;
  const owner = args.owner as OwnerInfo | null;
  const canDelete = owner?._id != null && String(owner._id) === String(user._id);
  const bulletin = typeof domain.bulletin === 'string' ? domain.bulletin : '';
  const bulletinHtml = bulletin ? markdown.render(bulletin) : '';

  return (
    <div className="uix-domain-dashboard">
      {bulletinHtml ? (
        <Card title={domain.name || i18n('Domain')}>
          <div className="uix-domain-dashboard__bulletin" dangerouslySetInnerHTML={{ __html: bulletinHtml }} />
        </Card>
      ) : null}
      <Card title={i18n('Information')}>
        <div className="uix-domain-dashboard__heading">
          <h1>{i18n('Information')}</h1>
          <form method="post">
            <input type="hidden" name="operation" value="init_discussion_node" />
            <Button type="submit" variant="primary">⚒ {i18n('Init Discussion Nodes')}</Button>
          </form>
        </div>
        <dl className="uix-domain-dashboard__details">
          <dt>{i18n('Avatar')}</dt>
          <dd><img src={domain.avatarUrl || '/img/team_avatar.png'} alt="" width="32" height="32" /></dd>
          <dt>{i18n('Name')}</dt>
          <dd>{domain.name || domain._id || ''}</dd>
          <dt>{i18n('Owner')}</dt>
          <dd className="uix-domain-dashboard__owner">
            {owner ? <><img src={owner.avatarUrl || '/img/avatar.png'} alt="" width="24" height="24" />{owner.uname || `#${owner._id}`}</> : i18n('Unknown')}
          </dd>
        </dl>
      </Card>
      {canDelete ? (
        <Card title={i18n('Delete Domain')}>
          <form method="post" onSubmit={(event) => {
            if (!window.confirm(i18n('Are you sure you want to delete this domain?'))) event.preventDefault();
          }}>
            <input type="hidden" name="operation" value="delete" />
            <Button type="submit" variant="primary">{i18n('Delete Domain')}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
