import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import moment from 'moment';
import { NamedPage } from '../misc/Page';
import { i18n } from 'vj/utils';

interface ContributionData {
  date: string;
  type: 'node' | 'card' | 'problem';
  count: number;
}

interface ContributionDetail {
  domainId: string;
  domainName: string;
  nodes: number;
  cards: number;
  problems: number;
  nodeStats?: { created: number; modified: number; deleted: number };
  cardStats?: { created: number; modified: number; deleted: number };
  problemStats?: { created: number; modified: number; deleted: number };
}

interface ContributionsProps {
  contributions: ContributionData[];
  theme: 'light' | 'dark';
  contributionDetails: Record<string, ContributionDetail[]>;
  onDateClick?: (date: string) => void;
}

function ContributionWall({ contributions, theme, contributionDetails, onDateClick }: ContributionsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const themeColors = useMemo(() => {
    const isDark = theme === 'dark';
    return {
      empty: isDark ? '#161b22' : '#ebedf0',
      level1: isDark ? '#0e4429' : '#c6e48b',
      level2: isDark ? '#006d32' : '#7bc96f',
      level3: isDark ? '#26a641' : '#239a3b',
      level4: isDark ? '#39d353' : '#196127',
      textPrimary: isDark ? '#eee' : '#24292e',
      textSecondary: isDark ? '#bdbdbd' : '#586069',
      textTertiary: isDark ? '#999' : '#666',
      bgTooltip: isDark ? '#1f2328' : '#333',
      bgTooltipText: isDark ? '#eee' : '#fff',
      bgTooltipTextSecondary: isDark ? '#bdbdbd' : '#999',
      border: isDark ? '#424242' : '#ddd',
    };
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const today = moment().endOf('day');
    const startDate = moment().subtract(364, 'days').startOf('week');
    const days = today.diff(startDate, 'days') + 1;
    const weeks = Math.ceil(days / 7);

    const cellSize = 11;
    const cellGap = 2;
    const weekWidth = cellSize + cellGap;
    const dayHeight = cellSize + cellGap;
    const width = weeks * weekWidth + 20;
    const height = 7 * dayHeight + 20;
    canvas.width = width;
    canvas.height = height;

    const contributionMap: Record<string, { nodes: number; cards: number; problems: number }> = {};
    contributions.forEach((contrib) => {
      if (!contrib.date) return;
      if (!contributionMap[contrib.date]) {
        contributionMap[contrib.date] = { nodes: 0, cards: 0, problems: 0 };
      }
      if (contrib.type === 'node') {
        contributionMap[contrib.date].nodes += contrib.count || 0;
      } else if (contrib.type === 'card') {
        contributionMap[contrib.date].cards += contrib.count || 0;
      } else if (contrib.type === 'problem') {
        contributionMap[contrib.date].problems += contrib.count || 0;
      }
    });

    const dateContributions: Record<string, number> = {};
    Object.keys(contributionMap).forEach((date) => {
      const data = contributionMap[date];
      dateContributions[date] = data.nodes + data.cards + data.problems;
    });

    const maxContributions = Math.max(...Object.values(dateContributions), 1);

    const getColor = (count: number): string => {
      if (count === 0) return themeColors.empty;
      const intensity = Math.min(count / maxContributions, 1);
      if (intensity < 0.25) return themeColors.level1;
      if (intensity < 0.5) return themeColors.level2;
      if (intensity < 0.75) return themeColors.level3;
      return themeColors.level4;
    };

    ctx.clearRect(0, 0, width, height);
    ctx.font = '10px monospace';
    ctx.fillStyle = themeColors.textSecondary;

    const weekDays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    for (let day = 0; day < 7; day++) {
      const y = 20 + day * dayHeight + cellSize / 2;
      ctx.fillText(weekDays[day], 0, y);
    }

    let lastMonth = -1;
    for (let week = 0; week < weeks; week++) {
      const weekDate = moment(startDate).add(week, 'weeks');
      const month = weekDate.month();
      if (month !== lastMonth && weekDate.date() <= 7) {
        const x = 20 + week * weekWidth;
        ctx.fillText(weekDate.format('MMM'), x, 10);
        lastMonth = month;
      }
    }

    const handleClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const week = Math.floor((x - 20) / weekWidth);
      const day = Math.floor((y - 20) / dayHeight);

      if (week >= 0 && week < weeks && day >= 0 && day < 7) {
        const targetDate = moment(startDate).add(week, 'weeks').day(day);
        if (targetDate.isSameOrAfter(startDate) && targetDate.isSameOrBefore(today)) {
          const dateStr = targetDate.format('YYYY-MM-DD');
          if (onDateClick) {
            onDateClick(dateStr);
          }
        }
      }
    };

    canvas.addEventListener('click', handleClick);

    for (let week = 0; week < weeks; week++) {
      for (let day = 0; day < 7; day++) {
        const targetDate = moment(startDate).add(week, 'weeks').day(day);
        if (targetDate.isBefore(startDate.startOf('day')) || targetDate.isAfter(today)) continue;

        const dateStr = targetDate.format('YYYY-MM-DD');
        const count = dateContributions[dateStr] || 0;
        const color = getColor(count);

        const x = 20 + week * weekWidth;
        const y = 20 + day * dayHeight;

        ctx.fillStyle = color;
        ctx.fillRect(x, y, cellSize, cellSize);
      }
    }

    return () => {
      canvas.removeEventListener('click', handleClick);
    };
  }, [contributions, themeColors, onDateClick]);

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '10px', fontSize: '14px', color: themeColors.textSecondary }}>
        {i18n('Contributions in the past year')}
      </div>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <canvas ref={canvasRef} style={{ border: `1px solid ${themeColors.border}`, borderRadius: '4px' }} />
      </div>
      <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: themeColors.textSecondary }}>
        <span>{i18n('Less')}</span>
        <div style={{ display: 'flex', gap: '2px' }}>
          <div style={{ width: '11px', height: '11px', background: themeColors.empty }} />
          <div style={{ width: '11px', height: '11px', background: themeColors.level1 }} />
          <div style={{ width: '11px', height: '11px', background: themeColors.level2 }} />
          <div style={{ width: '11px', height: '11px', background: themeColors.level3 }} />
          <div style={{ width: '11px', height: '11px', background: themeColors.level4 }} />
        </div>
        <span>{i18n('More')}</span>
      </div>
    </div>
  );
}

function UserDetailContributionsPage() {
  const contributions = (window as any).UiContext?.contributions || [];
  const contributionDetails = (window as any).UiContext?.contributionDetails || {};
  const stats = (window as any).UiContext?.stats || { totalNodes: 0, totalCards: 0, totalProblems: 0 };
  
  const getLatestContributionDate = useCallback(() => {
    const dates = Object.keys(contributionDetails);
    if (dates.length === 0) return null;
    
    const sortedDates = dates.sort((a, b) => {
      return moment(b).valueOf() - moment(a).valueOf();
    });
    
    return sortedDates[0];
  }, [contributionDetails]);
  
  const [selectedDateForDetails, setSelectedDateForDetails] = useState<string | null>(() => getLatestContributionDate());

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

  useEffect(() => {
    if (!selectedDateForDetails) {
      const latestDate = getLatestContributionDate();
      if (latestDate) {
        setSelectedDateForDetails(latestDate);
      }
    }
  }, [contributionDetails, selectedDateForDetails, getLatestContributionDate]);

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
        <h2 style={{ fontSize: '18px', marginBottom: '15px', fontWeight: 'bold', color: themeStyles.textPrimary }}>{i18n('Publish Statistics')}</h2>
        <div style={{ display: 'flex', gap: '30px' }}>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: themeStyles.statNode }}>
              {stats.totalNodes}
            </div>
            <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('Nodes')}</div>
          </div>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: themeStyles.statCard }}>
              {stats.totalCards}
            </div>
            <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('Cards')}</div>
          </div>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: themeStyles.statProblem }}>
              {stats.totalProblems}
            </div>
            <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('Problems')}</div>
          </div>
        </div>
      </div>

      <div>
        <h2 style={{ fontSize: '18px', marginBottom: '15px', fontWeight: 'bold', color: themeStyles.textPrimary }}>{i18n('Contribution Wall')}</h2>
        <ContributionWall 
          contributions={contributions} 
          theme={theme}
          contributionDetails={contributionDetails || {}}
          onDateClick={(date) => setSelectedDateForDetails(date)}
        />
        
        {selectedDateForDetails && contributionDetails[selectedDateForDetails] && (
          <div style={{ 
            marginTop: '30px', 
            padding: '20px', 
            background: themeStyles.bgSecondary, 
            borderRadius: '8px',
            border: `1px solid ${themeStyles.border}`,
          }}>
            <h3 style={{ 
              fontSize: '16px', 
              marginBottom: '15px', 
              fontWeight: 'bold', 
              color: themeStyles.textPrimary 
            }}>
              {i18n('Contributions on {0}', moment(selectedDateForDetails).format('YYYY-MM-DD'))}
            </h3>
            {contributionDetails[selectedDateForDetails].length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {contributionDetails[selectedDateForDetails].map((detail, index) => (
                  <div
                    key={`${detail.domainId}-${index}`}
                    style={{
                      padding: '12px 16px',
                      background: themeStyles.bgPrimary,
                      borderRadius: '6px',
                      border: `1px solid ${themeStyles.border}`,
                    }}
                  >
                    <div style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      alignItems: 'center',
                      marginBottom: '8px',
                    }}>
                      <a
                        href={`/user/${(window as any).UiContext?.udoc?._id}/contributions/${selectedDateForDetails}/${detail.domainId}`}
                        style={{
                          fontSize: '15px',
                          fontWeight: 'bold',
                          color: themeStyles.statNode,
                          textDecoration: 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.textDecoration = 'underline';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.textDecoration = 'none';
                        }}
                      >
                        {detail.domainName}
                      </a>
                    </div>
                    <div style={{ 
                      display: 'flex', 
                      gap: '20px', 
                      fontSize: '14px',
                      color: themeStyles.textSecondary,
                      marginBottom: '8px',
                    }}>
                      {detail.nodes > 0 && (
                        <span>
                          <span style={{ color: themeStyles.statNode, fontWeight: 'bold' }}>{detail.nodes}</span> {i18n('nodes')}
                        </span>
                      )}
                      {detail.cards > 0 && (
                        <span>
                          <span style={{ color: themeStyles.statCard, fontWeight: 'bold' }}>{detail.cards}</span> {i18n('cards')}
                        </span>
                      )}
                      {detail.problems > 0 && (
                        <span>
                          <span style={{ color: themeStyles.statProblem, fontWeight: 'bold' }}>{detail.problems}</span> {i18n('problems')}
                        </span>
                      )}
                      {detail.nodes === 0 && detail.cards === 0 && detail.problems === 0 && (
                        <span style={{ color: themeStyles.textTertiary }}>{i18n('No contributions')}</span>
                      )}
                    </div>
                    {(detail.nodeStats || detail.cardStats || detail.problemStats) && (
                      <div style={{ 
                        display: 'flex', 
                        flexDirection: 'column',
                        gap: '8px',
                        fontSize: '12px',
                        color: themeStyles.textTertiary,
                        paddingTop: '8px',
                        borderTop: `1px solid ${themeStyles.border}`,
                      }}>
                        {detail.nodeStats && (detail.nodeStats.created > 0 || detail.nodeStats.modified > 0 || detail.nodeStats.deleted > 0) && (
                          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <span style={{ color: themeStyles.statNode, minWidth: '60px' }}>{i18n('Nodes')}:</span>
                            {detail.nodeStats.created > 0 && (
                              <span>{i18n('Created')}: <span style={{ fontWeight: 'bold' }}>{detail.nodeStats.created}</span></span>
                            )}
                            {detail.nodeStats.modified > 0 && (
                              <span>{i18n('Modified')}: <span style={{ fontWeight: 'bold' }}>{detail.nodeStats.modified}</span></span>
                            )}
                            {detail.nodeStats.deleted > 0 && (
                              <span>{i18n('Deleted')}: <span style={{ fontWeight: 'bold' }}>{detail.nodeStats.deleted}</span></span>
                            )}
                          </div>
                        )}
                        {detail.cardStats && (detail.cardStats.created > 0 || detail.cardStats.modified > 0 || detail.cardStats.deleted > 0) && (
                          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <span style={{ color: themeStyles.statCard, minWidth: '60px' }}>{i18n('Cards')}:</span>
                            {detail.cardStats.created > 0 && (
                              <span>{i18n('Created')}: <span style={{ fontWeight: 'bold' }}>{detail.cardStats.created}</span></span>
                            )}
                            {detail.cardStats.modified > 0 && (
                              <span>{i18n('Modified')}: <span style={{ fontWeight: 'bold' }}>{detail.cardStats.modified}</span></span>
                            )}
                            {detail.cardStats.deleted > 0 && (
                              <span>{i18n('Deleted')}: <span style={{ fontWeight: 'bold' }}>{detail.cardStats.deleted}</span></span>
                            )}
                          </div>
                        )}
                        {detail.problemStats && (detail.problemStats.created > 0 || detail.problemStats.modified > 0 || detail.problemStats.deleted > 0) && (
                          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <span style={{ color: themeStyles.statProblem, minWidth: '60px' }}>{i18n('Problems')}:</span>
                            {detail.problemStats.created > 0 && (
                              <span>{i18n('Created')}: <span style={{ fontWeight: 'bold' }}>{detail.problemStats.created}</span></span>
                            )}
                            {detail.problemStats.modified > 0 && (
                              <span>{i18n('Modified')}: <span style={{ fontWeight: 'bold' }}>{detail.problemStats.modified}</span></span>
                            )}
                            {detail.problemStats.deleted > 0 && (
                              <span>{i18n('Deleted')}: <span style={{ fontWeight: 'bold' }}>{detail.problemStats.deleted}</span></span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: themeStyles.textTertiary, fontStyle: 'italic' }}>
                {i18n('No contribution records on this day')}
              </div>
            )}
            <div style={{ marginTop: '15px' }}>
              <button
                onClick={() => setSelectedDateForDetails(null)}
                style={{
                  padding: '8px 16px',
                  background: themeStyles.bgButton,
                  color: themeStyles.textPrimary,
                  border: `1px solid ${themeStyles.border}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = themeStyles.bgButtonHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = themeStyles.bgButton;
                }}
              >
                {i18n('Close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('user_detail', async () => {
  try {
    const $container = $('#contributions-container');
    if (!$container.length) {
      return;
    }

    ReactDOM.render(
      <UserDetailContributionsPage />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize contributions page:', error);
  }
});

export default page;
