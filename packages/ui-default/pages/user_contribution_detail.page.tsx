import React, { useEffect, useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import moment from 'moment';
import { NamedPage } from '../misc/Page';
import { i18n } from 'vj/utils';

interface ContributionNode {
  id: string;
  name: string;
  createdAt: Date;
  type: 'independent' | 'base';
}

interface ContributionCard {
  docId: string;
  title: string;
  nodeId: string;
  createdAt: Date;
  problems?: number;
}

interface ContributionProblem {
  cardId: string;
  cardTitle: string;
  pid: string;
  stem: string;
  createdAt: Date;
}

interface Contributions {
  nodes: ContributionNode[];
  cards: ContributionCard[];
  problems: ContributionProblem[];
}

function UserContributionDetailPage() {
  const udoc = (window as any).UiContext?.udoc;
  const targetDomain = (window as any).UiContext?.targetDomain;
  const date = (window as any).UiContext?.date;
  const contributions: Contributions = (window as any).UiContext?.contributions || { nodes: [], cards: [], problems: [] };
  const mindMapDocId = (window as any).UiContext?.mindMapDocId;

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
      textPrimary: isDark ? '#eee' : '#24292e',
      textSecondary: isDark ? '#bdbdbd' : '#586069',
      textTertiary: isDark ? '#999' : '#666',
      border: isDark ? '#424242' : '#e1e4e8',
      statNode: isDark ? '#64b5f6' : '#2196F3',
      statCard: isDark ? '#81c784' : '#4CAF50',
      statProblem: isDark ? '#ffb74d' : '#FF9800',
      link: isDark ? '#55b6e2' : '#0366d6',
    };
  }, [theme]);

  const getNodeLink = (node: ContributionNode) => {
    if (node.type === 'independent') {
      return `/d/${targetDomain._id}/node/${node.id}`;
    } else if (node.type === 'base' && mindMapDocId) {
      return `/d/${targetDomain._id}/base/${mindMapDocId}?nodeId=${node.id}`;
    }
    return null;
  };

  const getCardLink = (card: ContributionCard) => {
    if (mindMapDocId && card.nodeId) {
      return `/d/${targetDomain._id}/base/${mindMapDocId}/branch/main/node/${card.nodeId}/cards?cardId=${card.docId}`;
    }
    return null;
  };

  const totalContributions = contributions.nodes.length + contributions.cards.length + contributions.problems.length;

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '30px' }}>
        <div style={{ 
          fontSize: '24px', 
          fontWeight: 'bold', 
          color: themeStyles.textPrimary,
          marginBottom: '10px',
        }}>
          {i18n('Contributions on {0} in {1}', moment(date).format('YYYY-MM-DD'), targetDomain?.name || targetDomain?._id)}
        </div>
        <div style={{ 
          fontSize: '14px', 
          color: themeStyles.textSecondary,
          display: 'flex',
          gap: '20px',
        }}>
          <span>
            <span style={{ color: themeStyles.statNode, fontWeight: 'bold' }}>{contributions.nodes.length}</span> {i18n('nodes')}
          </span>
          <span>
            <span style={{ color: themeStyles.statCard, fontWeight: 'bold' }}>{contributions.cards.length}</span> {i18n('cards')}
          </span>
          <span>
            <span style={{ color: themeStyles.statProblem, fontWeight: 'bold' }}>{contributions.problems.length}</span> {i18n('problems')}
          </span>
          <span>
            {i18n('Total')}: <span style={{ fontWeight: 'bold' }}>{totalContributions}</span>
          </span>
        </div>
      </div>

      {contributions.nodes.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h2 style={{ 
            fontSize: '18px', 
            marginBottom: '15px', 
            fontWeight: 'bold', 
            color: themeStyles.textPrimary,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <span style={{ 
              width: '4px', 
              height: '18px', 
              background: themeStyles.statNode,
              borderRadius: '2px',
            }} />
            {i18n('Nodes')} ({contributions.nodes.length})
          </h2>
          <div style={{ 
            background: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.border}`,
            borderRadius: '8px',
            overflow: 'hidden',
          }}>
            {contributions.nodes.map((node, index) => {
              const link = getNodeLink(node);
              const content = (
                <div
                  key={`node-${node.id}-${index}`}
                  style={{
                    padding: '12px 16px',
                    borderBottom: index < contributions.nodes.length - 1 ? `1px solid ${themeStyles.border}` : 'none',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    if (link) {
                      e.currentTarget.style.background = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = themeStyles.bgPrimary;
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ 
                      fontSize: '15px', 
                      fontWeight: '500',
                      color: link ? themeStyles.link : themeStyles.textPrimary,
                      marginBottom: '4px',
                    }}>
                      {node.name || i18n('Unnamed Node')}
                    </div>
                    <div style={{ 
                      fontSize: '12px', 
                      color: themeStyles.textSecondary,
                      display: 'flex',
                      gap: '12px',
                    }}>
                      <span>{i18n('Type')}: {node.type === 'independent' ? i18n('Independent Node') : i18n('Base Node')}</span>
                      <span>{i18n('Created at')}: {moment(node.createdAt).format('HH:mm:ss')}</span>
                    </div>
                  </div>
                  {link && (
                    <div style={{ marginLeft: '16px' }}>
                      <span style={{ 
                        fontSize: '12px', 
                        color: themeStyles.textSecondary,
                      }}>→</span>
                    </div>
                  )}
                </div>
              );

              return link ? (
                <a
                  key={`node-link-${node.id}-${index}`}
                  href={link}
                  style={{ textDecoration: 'none', display: 'block' }}
                >
                  {content}
                </a>
              ) : (
                content
              );
            })}
          </div>
        </div>
      )}

      {contributions.cards.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h2 style={{ 
            fontSize: '18px', 
            marginBottom: '15px', 
            fontWeight: 'bold', 
            color: themeStyles.textPrimary,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <span style={{ 
              width: '4px', 
              height: '18px', 
              background: themeStyles.statCard,
              borderRadius: '2px',
            }} />
            {i18n('Cards')} ({contributions.cards.length})
          </h2>
          <div style={{ 
            background: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.border}`,
            borderRadius: '8px',
            overflow: 'hidden',
          }}>
            {contributions.cards.map((card, index) => {
              const link = getCardLink(card);
              const content = (
                <div
                  key={`card-${card.docId}-${index}`}
                  style={{
                    padding: '12px 16px',
                    borderBottom: index < contributions.cards.length - 1 ? `1px solid ${themeStyles.border}` : 'none',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    if (link) {
                      e.currentTarget.style.background = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = themeStyles.bgPrimary;
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ 
                      fontSize: '15px', 
                      fontWeight: '500',
                      color: link ? themeStyles.link : themeStyles.textPrimary,
                      marginBottom: '4px',
                    }}>
                      {card.title || i18n('Unnamed Card')}
                    </div>
                    <div style={{ 
                      fontSize: '12px', 
                      color: themeStyles.textSecondary,
                      display: 'flex',
                      gap: '12px',
                    }}>
                      <span>{i18n('Node ID')}: {card.nodeId || 'N/A'}</span>
                      <span>{i18n('Created at')}: {moment(card.createdAt).format('HH:mm:ss')}</span>
                      {card.problems && card.problems > 0 && (
                        <span style={{ color: themeStyles.statProblem }}>
                          {i18n('Contains {0} problems', card.problems)}
                        </span>
                      )}
                    </div>
                  </div>
                  {link && (
                    <div style={{ marginLeft: '16px' }}>
                      <span style={{ 
                        fontSize: '12px', 
                        color: themeStyles.textSecondary,
                      }}>→</span>
                    </div>
                  )}
                </div>
              );

              return link ? (
                <a
                  key={`card-link-${card.docId}-${index}`}
                  href={link}
                  style={{ textDecoration: 'none', display: 'block' }}
                >
                  {content}
                </a>
              ) : (
                content
              );
            })}
          </div>
        </div>
      )}

      {contributions.problems.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h2 style={{ 
            fontSize: '18px', 
            marginBottom: '15px', 
            fontWeight: 'bold', 
            color: themeStyles.textPrimary,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <span style={{ 
              width: '4px', 
              height: '18px', 
              background: themeStyles.statProblem,
              borderRadius: '2px',
            }} />
            {i18n('Problems')} ({contributions.problems.length})
          </h2>
          <div style={{ 
            background: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.border}`,
            borderRadius: '8px',
            overflow: 'hidden',
          }}>
            {contributions.problems.map((problem, index) => {
              const cardLink = getCardLink({ docId: problem.cardId, nodeId: '', title: problem.cardTitle, createdAt: problem.createdAt });
              const content = (
                <div
                  key={`problem-${problem.pid}-${index}`}
                  style={{
                    padding: '12px 16px',
                    borderBottom: index < contributions.problems.length - 1 ? `1px solid ${themeStyles.border}` : 'none',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    if (cardLink) {
                      e.currentTarget.style.background = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = themeStyles.bgPrimary;
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ 
                      fontSize: '14px', 
                      color: themeStyles.textPrimary,
                      marginBottom: '4px',
                      lineHeight: '1.5',
                    }}>
                      {problem.stem || i18n('No stem')}
                    </div>
                    <div style={{ 
                      fontSize: '12px', 
                      color: themeStyles.textSecondary,
                      display: 'flex',
                      gap: '12px',
                    }}>
                      <span>{i18n('Problem ID')}: {problem.pid}</span>
                      <span>{i18n('Belongs to card')}: {problem.cardTitle}</span>
                      <span>{i18n('Created at')}: {moment(problem.createdAt).format('HH:mm:ss')}</span>
                    </div>
                  </div>
                  {cardLink && (
                    <div style={{ marginLeft: '16px' }}>
                      <a
                        href={cardLink}
                        style={{ 
                          fontSize: '12px', 
                          color: themeStyles.link,
                          textDecoration: 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.textDecoration = 'underline';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.textDecoration = 'none';
                        }}
                      >
                        {i18n('View Card')} →
                      </a>
                    </div>
                  )}
                </div>
              );

              return content;
            })}
          </div>
        </div>
      )}

      {totalContributions === 0 && (
        <div style={{ 
          padding: '40px',
          textAlign: 'center',
          color: themeStyles.textTertiary,
        }}>
          <div style={{ fontSize: '16px', marginBottom: '8px' }}>{i18n('No contribution records on this day')}</div>
          <div style={{ fontSize: '14px' }}>{i18n('Back to')} <a href={`/user/${udoc?._id}`} style={{ color: themeStyles.link }}>{i18n('User Detail')}</a></div>
        </div>
      )}
    </div>
  );
}

const page = new NamedPage('user_contribution_detail', async () => {
  try {
    const $container = $('#contribution-detail-container');
    if (!$container.length) {
      return;
    }

    ReactDOM.render(
      <UserContributionDetailPage />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize contribution detail page:', error);
  }
});

export default page;
