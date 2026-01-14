import React, { useEffect, useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import moment from 'moment';
import { NamedPage } from '../misc/Page';
import { i18n } from 'vj/utils';

function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    if (minutes === 0 && remainingSeconds === 0) {
      return `${hours}h`;
    } else if (remainingSeconds === 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${hours}h ${minutes}m ${remainingSeconds}s`;
    }
  }
}

interface ConsumptionNode {
  id: string;
  name: string;
  createdAt: Date;
  type: 'mindmap';
}

interface ConsumptionCard {
  docId: string;
  title: string;
  nodeId: string;
  createdAt: Date;
  totalTime?: number;
}

interface ConsumptionProblem {
  cardId: string;
  cardTitle: string;
  pid: string;
  stem: string;
  createdAt: Date;
  totalTime?: number;
}

interface ConsumptionPractice {
  cardId: string;
  cardTitle: string;
  nodeId: string;
  passedAt: Date;
  totalTime?: number;
}

interface Consumptions {
  nodes: ConsumptionNode[];
  cards: ConsumptionCard[];
  problems: ConsumptionProblem[];
  practices: ConsumptionPractice[];
}

function UserConsumptionDetailPage() {
  const udoc = (window as any).UiContext?.udoc;
  const targetDomain = (window as any).UiContext?.targetDomain;
  const date = (window as any).UiContext?.date;
  const contributions: Consumptions = (window as any).UiContext?.contributions || { nodes: [], cards: [], problems: [], practices: [] };
  const mindMapDocId = (window as any).UiContext?.mindMapDocId;
  const totalTimeInSeconds = (window as any).UiContext?.totalTimeInSeconds || 0;

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
      statPractice: isDark ? '#4caf50' : '#1a7f37',
      link: isDark ? '#55b6e2' : '#0366d6',
    };
  }, [theme]);

  const getNodeLink = (node: ConsumptionNode) => {
    if (node.type === 'mindmap' && mindMapDocId) {
      return `/d/${targetDomain._id}/mindmap/${mindMapDocId}?nodeId=${node.id}`;
    }
    return null;
  };

  const getCardLink = (card: ConsumptionCard) => {
    if (mindMapDocId && card.nodeId) {
      return `/d/${targetDomain._id}/mindmap/${mindMapDocId}/branch/main/node/${card.nodeId}/cards?cardId=${card.docId}`;
    }
    return null;
  };

  const totalConsumptions = contributions.nodes.length + contributions.cards.length + contributions.problems.length + contributions.practices.length;

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '30px' }}>
        <div style={{ 
          fontSize: '24px', 
          fontWeight: 'bold', 
          color: themeStyles.textPrimary,
          marginBottom: '10px',
        }}>
          {i18n('Consumption on {0} in {1}', moment(date).format('YYYY-MM-DD'), targetDomain?.name || targetDomain?._id)}
        </div>
        <div style={{ 
          fontSize: '14px', 
          color: themeStyles.textSecondary,
          display: 'flex',
          gap: '20px',
          flexWrap: 'wrap',
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
            <span style={{ color: themeStyles.statPractice, fontWeight: 'bold' }}>{contributions.practices.length}</span> {i18n('practices')}
          </span>
          <span>
            {i18n('Total')}: <span style={{ fontWeight: 'bold' }}>{totalConsumptions}</span>
          </span>
          {totalTimeInSeconds > 0 && (
            <span>
              {i18n('Total Time')}: <span style={{ fontWeight: 'bold', color: themeStyles.statProblem }}>{formatTime(totalTimeInSeconds)}</span>
            </span>
          )}
        </div>
      </div>

      {contributions.nodes.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h3 style={{ 
            fontSize: '18px', 
            marginBottom: '15px', 
            fontWeight: 'bold',
            color: themeStyles.textPrimary,
          }}>
            {i18n('Nodes')} ({contributions.nodes.length})
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
            gap: '12px',
          }}>
            {contributions.nodes.map((node, idx) => {
              const link = getNodeLink(node);
              return (
                <div
                  key={idx}
                  style={{
                    padding: '12px',
                    background: themeStyles.bgSecondary,
                    borderRadius: '6px',
                    border: `1px solid ${themeStyles.border}`,
                    cursor: link ? 'pointer' : 'default',
                  }}
                  onClick={() => link && (window.location.href = link)}
                  onMouseEnter={(e) => {
                    if (link) {
                      e.currentTarget.style.background = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (link) {
                      e.currentTarget.style.background = themeStyles.bgSecondary;
                    }
                  }}
                >
                  <div style={{ 
                    fontSize: '14px', 
                    fontWeight: '500',
                    color: themeStyles.textPrimary,
                    marginBottom: '4px',
                  }}>
                    {node.name}
                  </div>
                  <div style={{ 
                    fontSize: '12px', 
                    color: themeStyles.textSecondary,
                  }}>
                    {moment(node.createdAt).format('HH:mm:ss')}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {contributions.cards.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h3 style={{ 
            fontSize: '18px', 
            marginBottom: '15px', 
            fontWeight: 'bold',
            color: themeStyles.textPrimary,
          }}>
            {i18n('Cards')} ({contributions.cards.length})
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
            gap: '12px',
          }}>
            {contributions.cards.map((card, idx) => {
              const link = getCardLink(card);
              return (
                <div
                  key={idx}
                  style={{
                    padding: '12px',
                    background: themeStyles.bgSecondary,
                    borderRadius: '6px',
                    border: `1px solid ${themeStyles.border}`,
                    cursor: link ? 'pointer' : 'default',
                  }}
                  onClick={() => link && (window.location.href = link)}
                  onMouseEnter={(e) => {
                    if (link) {
                      e.currentTarget.style.background = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (link) {
                      e.currentTarget.style.background = themeStyles.bgSecondary;
                    }
                  }}
                >
                  <div style={{ 
                    fontSize: '14px', 
                    fontWeight: '500',
                    color: themeStyles.textPrimary,
                    marginBottom: '4px',
                  }}>
                    {card.title}
                  </div>
                  <div style={{ 
                    fontSize: '12px', 
                    color: themeStyles.textSecondary,
                  }}>
                    {moment(card.createdAt).format('HH:mm:ss')}
                    {card.totalTime !== undefined && (
                      <span style={{ marginLeft: '8px' }}>
                        · {i18n('Time')}: {Math.round(card.totalTime / 1000)}s
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {contributions.problems.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h3 style={{ 
            fontSize: '18px', 
            marginBottom: '15px', 
            fontWeight: 'bold',
            color: themeStyles.textPrimary,
          }}>
            {i18n('Problems')} ({contributions.problems.length})
          </h3>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}>
            {contributions.problems.map((problem, idx) => {
              const cardLink = getCardLink({ docId: problem.cardId, nodeId: '', createdAt: problem.createdAt, title: problem.cardTitle });
              return (
                <div
                  key={idx}
                  style={{
                    padding: '12px',
                    background: themeStyles.bgSecondary,
                    borderRadius: '6px',
                    border: `1px solid ${themeStyles.border}`,
                  }}
                >
                  <div style={{ 
                    fontSize: '14px', 
                    fontWeight: '500',
                    color: themeStyles.textPrimary,
                    marginBottom: '4px',
                  }}>
                    {problem.stem}
                  </div>
                  <div style={{ 
                    fontSize: '12px', 
                    color: themeStyles.textSecondary,
                    display: 'flex',
                    gap: '12px',
                    flexWrap: 'wrap',
                  }}>
                    <span>{i18n('Card')}: {problem.cardTitle}</span>
                    <span>{moment(problem.createdAt).format('HH:mm:ss')}</span>
                    {problem.totalTime !== undefined && problem.totalTime > 0 && (
                      <span style={{ color: themeStyles.statProblem, fontWeight: '500' }}>
                        {i18n('Time')}: {formatTime(Math.round(problem.totalTime / 1000))}
                      </span>
                    )}
                    {cardLink && (
                      <a
                        href={cardLink}
                        style={{
                          color: themeStyles.link,
                          textDecoration: 'none',
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {i18n('View Card')} →
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {contributions.practices.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h3 style={{ 
            fontSize: '18px', 
            marginBottom: '15px', 
            fontWeight: 'bold',
            color: themeStyles.textPrimary,
          }}>
            {i18n('Practices')} ({contributions.practices.length})
          </h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
            gap: '12px',
          }}>
            {contributions.practices.map((practice, idx) => {
              const cardLink = getCardLink({ docId: practice.cardId, nodeId: practice.nodeId, createdAt: practice.passedAt, title: practice.cardTitle });
              return (
                <div
                  key={idx}
                  style={{
                    padding: '12px',
                    background: themeStyles.bgSecondary,
                    borderRadius: '6px',
                    border: `1px solid ${themeStyles.border}`,
                    cursor: cardLink ? 'pointer' : 'default',
                  }}
                  onClick={() => cardLink && (window.location.href = cardLink)}
                  onMouseEnter={(e) => {
                    if (cardLink) {
                      e.currentTarget.style.background = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (cardLink) {
                      e.currentTarget.style.background = themeStyles.bgSecondary;
                    }
                  }}
                >
                  <div style={{ 
                    fontSize: '14px', 
                    fontWeight: '500',
                    color: themeStyles.textPrimary,
                    marginBottom: '4px',
                  }}>
                    {practice.cardTitle}
                  </div>
                  <div style={{ 
                    fontSize: '12px', 
                    color: themeStyles.textSecondary,
                  }}>
                    {i18n('Passed at')} {moment(practice.passedAt).format('HH:mm:ss')}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {totalConsumptions === 0 && (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          color: themeStyles.textTertiary,
        }}>
          {i18n('No consumption on this date.')}
        </div>
      )}
    </div>
  );
}

const page = new NamedPage('user_consumption_detail', async () => {
  try {
    const $container = $('#consumption-detail-container');
    if (!$container.length) {
      return;
    }

    ReactDOM.render(
      <UserConsumptionDetailPage />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize consumption detail page:', error);
  }
});

export default page;
