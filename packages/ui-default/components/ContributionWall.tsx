import React, { useEffect, useRef, useMemo } from 'react';
import moment from 'moment';
import { i18n } from 'vj/utils';

export interface ContributionData {
  date: string;
  type: 'node' | 'card' | 'problem';
  count: number;
}

export interface ContributionDetail {
  domainId: string;
  domainName: string;
  nodes: number;
  cards: number;
  problems: number;
  nodeStats?: { created: number; modified: number; deleted: number };
  cardStats?: { created: number; modified: number; deleted: number };
  problemStats?: { created: number; modified: number; deleted: number };
}

export interface ContributionWallProps {
  contributions: ContributionData[];
  theme: 'light' | 'dark';
  contributionDetails: Record<string, ContributionDetail[]>;
  onDateClick?: (date: string) => void;
  compact?: boolean;
}

export function ContributionWall({ contributions, theme, contributionDetails, onDateClick, compact = false }: ContributionWallProps) {
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

  const padding = compact ? '8px 0' : '20px';
  return (
    <div style={{ padding }}>
      <div style={{ marginBottom: compact ? '6px' : '10px', fontSize: compact ? '12px' : '14px', color: themeColors.textSecondary }}>
        {i18n('Contributions in the past year')}
      </div>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <canvas ref={canvasRef} style={{ border: `1px solid ${themeColors.border}`, borderRadius: '4px' }} />
      </div>
      <div style={{ marginTop: compact ? '6px' : '10px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: themeColors.textSecondary }}>
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
