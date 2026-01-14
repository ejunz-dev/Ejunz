import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
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

interface ConsumptionData {
  date: string;
  type: 'node' | 'card' | 'problem' | 'practice';
  count: number;
}

interface ConsumptionDetail {
  domainId: string;
  domainName: string;
  nodes: number;
  cards: number;
  problems: number;
  practices: number;
  totalTime?: number;
}

interface ConsumptionsProps {
  consumptions: ConsumptionData[];
  theme: 'light' | 'dark';
  consumptionDetails: Record<string, ConsumptionDetail[]>;
  onDateClick?: (date: string) => void;
}

function ConsumptionWall({ consumptions, theme, consumptionDetails, onDateClick }: ConsumptionsProps) {
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

    const consumptionMap: Record<string, { nodes: number; cards: number; problems: number; practices: number }> = {};
    consumptions.forEach((consumption) => {
      if (!consumptionMap[consumption.date]) {
        consumptionMap[consumption.date] = { nodes: 0, cards: 0, problems: 0, practices: 0 };
      }
      if (consumption.type === 'node') {
        consumptionMap[consumption.date].nodes += consumption.count;
      } else if (consumption.type === 'card') {
        consumptionMap[consumption.date].cards += consumption.count;
      } else if (consumption.type === 'problem') {
        consumptionMap[consumption.date].problems += consumption.count;
      } else if (consumption.type === 'practice') {
        consumptionMap[consumption.date].practices += consumption.count;
      }
    });

    const dateConsumptions: Record<string, number> = {};
    Object.keys(consumptionMap).forEach((date) => {
      const data = consumptionMap[date];
      dateConsumptions[date] = data.nodes + data.cards + data.problems + data.practices;
    });

    const maxConsumptions = Math.max(...Object.values(dateConsumptions), 1);

    const getColor = (count: number): string => {
      if (count === 0) return themeColors.empty;
      const intensity = Math.min(count / maxConsumptions, 1);
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
        const count = dateConsumptions[dateStr] || 0;
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
  }, [consumptions, themeColors, onDateClick]);

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '10px', fontSize: '14px', color: themeColors.textSecondary }}>
        {i18n('Consumption in the past year')}
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

function UserDetailConsumptionPage() {
  const consumptions = (window as any).UiContext?.consumptions || [];
  const consumptionDetails = (window as any).UiContext?.consumptionDetails || {};
  const consumptionStats = (window as any).UiContext?.consumptionStats || { totalNodes: 0, totalCards: 0, totalProblems: 0, totalTime: 0 };
  
  const getLatestConsumptionDate = useCallback(() => {
    const dates = Object.keys(consumptionDetails);
    if (dates.length === 0) return null;
    
    const sortedDates = dates.sort((a, b) => {
      return moment(b).valueOf() - moment(a).valueOf();
    });
    
    return sortedDates[0];
  }, [consumptionDetails]);
  
  const [selectedDateForDetails, setSelectedDateForDetails] = useState<string | null>(() => getLatestConsumptionDate());

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
      const latestDate = getLatestConsumptionDate();
      if (latestDate) {
        setSelectedDateForDetails(latestDate);
      }
    }
  }, [consumptionDetails, selectedDateForDetails, getLatestConsumptionDate]);

  const themeStyles = useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bgPrimary: isDark ? '#0d1117' : '#ffffff',
      bgSecondary: isDark ? '#161b22' : '#f6f8fa',
      textPrimary: isDark ? '#c9d1d9' : '#24292f',
      textSecondary: isDark ? '#8b949e' : '#57606a',
      textTertiary: isDark ? '#6e7681' : '#8c959f',
      border: isDark ? '#30363d' : '#d0d7de',
      statNode: isDark ? '#58a6ff' : '#0969da',
      statCard: isDark ? '#a5a5ff' : '#8250df',
      statProblem: isDark ? '#f85149' : '#cf222e',
      statPractice: isDark ? '#3fb950' : '#1a7f37',
      statTime: isDark ? '#ffa726' : '#ff9800',
    };
  }, [theme]);

  const getDomainName = (domainId: string) => {
    const details = consumptionDetails[selectedDateForDetails || ''] || [];
    const detail = details.find((d: ConsumptionDetail) => d.domainId === domainId);
    return detail?.domainName || domainId;
  };

  return (
    <div style={{ padding: '20px', background: themeStyles.bgPrimary, minHeight: '100vh' }}>
      <div>
        <div style={{
          display: 'flex',
          justifyContent: 'space-around',
          padding: '20px',
          background: themeStyles.bgSecondary,
          borderRadius: '8px',
          marginBottom: '30px',
          border: `1px solid ${themeStyles.border}`,
        }}>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: themeStyles.statNode }}>
              {consumptionStats.totalNodes}
            </div>
            <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('nodes')}</div>
          </div>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: themeStyles.statCard }}>
              {consumptionStats.totalCards}
            </div>
            <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('cards')}</div>
          </div>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: themeStyles.statProblem }}>
              {consumptionStats.totalProblems}
            </div>
            <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('problems')}</div>
          </div>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: themeStyles.statTime }}>
              {formatTime(consumptionStats.totalTime || 0)}
            </div>
            <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('Practice Time')}</div>
          </div>
        </div>

        <h2 style={{ fontSize: '18px', marginBottom: '15px', fontWeight: 'bold', color: themeStyles.textPrimary }}>{i18n('Consumption Wall')}</h2>
        <ConsumptionWall 
          consumptions={consumptions} 
          theme={theme}
          consumptionDetails={consumptionDetails || {}}
          onDateClick={(date) => setSelectedDateForDetails(date)}
        />
        
        {selectedDateForDetails && consumptionDetails[selectedDateForDetails] && (
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
              {i18n('Consumption on {0}', moment(selectedDateForDetails).format('YYYY-MM-DD'))}
            </h3>
            {consumptionDetails[selectedDateForDetails].length > 0 ? (
              <>
                {(() => {
                  const totalTimeForDate = consumptionDetails[selectedDateForDetails].reduce((sum, detail) => sum + ((detail.totalTime || 0) / 1000), 0);
                  return totalTimeForDate > 0 ? (
                    <div style={{ 
                      marginBottom: '15px', 
                      padding: '12px', 
                      background: themeStyles.bgPrimary, 
                      borderRadius: '6px',
                      border: `1px solid ${themeStyles.border}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                    }}>
                      <span style={{ fontSize: '14px', color: themeStyles.textSecondary }}>
                        {i18n('Total Practice Time')}:
                      </span>
                      <span style={{ fontSize: '16px', fontWeight: 'bold', color: themeStyles.statTime }}>
                        {formatTime(Math.round(totalTimeForDate))}
                      </span>
                    </div>
                  ) : null;
                })()}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {consumptionDetails[selectedDateForDetails].map((detail: ConsumptionDetail, idx: number) => {
                    const total = detail.nodes + detail.cards + detail.problems + detail.practices;
                    if (total === 0) return null;
                  
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: '16px',
                        background: themeStyles.bgPrimary,
                        borderRadius: '6px',
                        border: `1px solid ${themeStyles.border}`,
                      }}
                    >
                      <div style={{ 
                        fontSize: '14px', 
                        fontWeight: 'bold', 
                        marginBottom: '12px',
                        color: themeStyles.textPrimary,
                      }}>
                        {detail.domainName}
                      </div>
                      <div style={{ 
                        display: 'flex', 
                        gap: '20px', 
                        flexWrap: 'wrap',
                        fontSize: '13px',
                        color: themeStyles.textSecondary,
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
                        {detail.practices > 0 && (
                          <span>
                            <span style={{ color: themeStyles.statPractice, fontWeight: 'bold' }}>{detail.practices}</span> {i18n('practices')}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto' }}>
                          {i18n('Total')}: <span style={{ fontWeight: 'bold' }}>{total}</span>
                        </span>
                      </div>
                      {detail.totalTime && detail.totalTime > 0 && (
                        <div style={{ 
                          marginTop: '8px',
                          paddingTop: '8px',
                          borderTop: `1px solid ${themeStyles.border}`,
                          fontSize: '13px',
                          color: themeStyles.textSecondary,
                        }}>
                          <span>{i18n('Practice Time')}: </span>
                          <span style={{ color: themeStyles.statTime, fontWeight: 'bold' }}>
                            {formatTime(Math.round((detail.totalTime || 0) / 1000))}
                          </span>
                        </div>
                      )}
                      <div style={{ marginTop: '12px' }}>
                        <a
                          href={`/user/${(window as any).UiContext?.udoc?._id || ''}/consumption/${selectedDateForDetails}/${detail.domainId}`}
                          style={{
                            fontSize: '12px',
                            color: themeStyles.statNode,
                            textDecoration: 'none',
                          }}
                        >
                          {i18n('View Details')} →
                        </a>
                      </div>
                    </div>
                  );
                })}
                </div>
              </>
            ) : (
              <div style={{ 
                padding: '20px', 
                textAlign: 'center',
                color: themeStyles.textTertiary,
              }}>
                {i18n('No consumption on this date.')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('user_detail', async () => {
  try {
    const $container = $('#consumption-container');
    if (!$container.length) {
      return;
    }

    ReactDOM.render(
      <UserDetailConsumptionPage />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize consumption page:', error);
  }
});

export default page;
