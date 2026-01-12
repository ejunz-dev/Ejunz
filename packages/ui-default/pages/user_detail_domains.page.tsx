import React, { useEffect, useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import moment from 'moment';
import { NamedPage } from '../misc/Page';
import { i18n } from 'vj/utils';

function UserDetailDomainsPage() {
  const joinedDomains = (window as any).UiContext?.joinedDomains || [];

  const getTheme = useCallback(() => {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) {
        return (window as any).Ejunz.utils.getTheme();
      }
      if ((window as any).UserContext?.theme) {
        return (window as any).UserContext.theme === 'dark' ? 'dark' : 'light';
      }
    } catch (e) {
      console.warn('Failed to get theme:', e);
    }
    return 'light';
  }, []);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => getTheme());

  useEffect(() => {
    const checkTheme = () => {
      const newTheme = getTheme();
      if (newTheme !== theme) {
        setTheme(newTheme);
      }
    };

    checkTheme();

    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme, getTheme]);

  const themeStyles = useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bgPrimary: isDark ? '#121212' : '#fff',
      bgSecondary: isDark ? '#323334' : '#f6f8fa',
      bgHover: isDark ? '#424242' : '#f3f4f6',
      bgButton: isDark ? '#323334' : '#f0f0f0',
      bgButtonHover: isDark ? '#424242' : '#e0e0e0',
      textPrimary: isDark ? '#eee' : '#24292e',
      textSecondary: isDark ? '#bdbdbd' : '#586069',
      textTertiary: isDark ? '#999' : '#666',
      border: isDark ? '#424242' : '#e1e4e8',
      statNode: isDark ? '#64b5f6' : '#2196F3',
      statCard: isDark ? '#81c784' : '#4CAF50',
      statProblem: isDark ? '#ffb74d' : '#FF9800',
    };
  }, [theme]);

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '18px', marginBottom: '15px', fontWeight: 'bold', color: themeStyles.textPrimary }}>
          {i18n('Joined Domains')}
        </h2>
        {joinedDomains.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
            {joinedDomains.map((domain: any) => (
              <a
                key={domain.id}
                href={`/d/${domain.id}/`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '16px',
                  background: themeStyles.bgPrimary,
                  borderRadius: '8px',
                  textDecoration: 'none',
                  color: themeStyles.textPrimary,
                  transition: 'all 0.2s',
                  border: `1px solid ${themeStyles.border}`,
                  gap: '12px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = themeStyles.bgHover;
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = `0 4px 12px rgba(0, 0, 0, ${theme === 'dark' ? '0.3' : '0.1'})`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = themeStyles.bgPrimary;
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <img
                  src={domain.avatarUrl || '/img/team_avatar.png'}
                  alt={domain.name || domain.id}
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '8px',
                    objectFit: 'cover',
                    flexShrink: 0,
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = '/img/team_avatar.png';
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '15px',
                    fontWeight: '500',
                    color: themeStyles.textPrimary,
                    marginBottom: '4px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {domain.name || domain.id}
                  </div>
                  <div style={{
                    fontSize: '12px',
                    color: themeStyles.textSecondary,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                      {domain.nodeCount !== undefined && (
                        <span style={{ color: themeStyles.statNode }}>
                          {i18n('Nodes')}: <strong>{domain.nodeCount}</strong>
                        </span>
                      )}
                      {domain.cardCount !== undefined && (
                        <span style={{ color: themeStyles.statCard }}>
                          {i18n('Cards')}: <strong>{domain.cardCount}</strong>
                        </span>
                      )}
                      {domain.problemCount !== undefined && (
                        <span style={{ color: themeStyles.statProblem }}>
                          {i18n('Problems')}: <strong>{domain.problemCount}</strong>
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px' }}>
                      {domain.userCount !== undefined && (
                        <span>
                          {i18n('Members')}: {domain.userCount}
                        </span>
                      )}
                      {domain.role && domain.role !== 'default' && (
                        <span>
                          {i18n('Role')}: {domain.role}
                        </span>
                      )}
                      {domain.joinAt && (
                        <span>
                          {i18n('Joined at')}: {moment(domain.joinAt).format('YYYY-MM-DD HH:mm')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div style={{
            padding: '40px',
            textAlign: 'center',
            color: themeStyles.textTertiary,
            background: themeStyles.bgSecondary,
            borderRadius: '8px',
            border: `1px solid ${themeStyles.border}`,
          }}>
            {i18n('No domains joined.')}
          </div>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('user_detail', async () => {
  try {
    const $container = $('#domains-container');
    if (!$container.length) {
      return;
    }

    ReactDOM.render(
      <UserDetailDomainsPage />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize domains page:', error);
  }
});

export default page;
