import React, { useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import moment from 'moment';

interface DomainTask {
  domainId: string;
  domainName: string;
  domainAvatar: string;
  dailyGoal: number;
  todayCompleted: number;
  consecutiveDays: number;
}

interface TaskSummary {
  totalDomains: number;
  totalDailyGoal: number;
  totalTodayCompleted: number;
  maxConsecutiveDays: number;
}

function UserTaskPage() {
  const udoc = (window as any).UiContext?.udoc;
  const domainTasks: DomainTask[] = (window as any).UiContext?.domainTasks || [];
  const currentDomainId = (window as any).UiContext?.domainId as string | undefined;
  const summary: TaskSummary = (window as any).UiContext?.summary || {
    totalDomains: 0,
    totalDailyGoal: 0,
    totalTodayCompleted: 0,
    maxConsecutiveDays: 0,
  };

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

  const themeStyles = {
    bgPrimary: theme === 'dark' ? '#121212' : '#fff',
    bgSecondary: theme === 'dark' ? '#323334' : '#f6f8fa',
    bgHover: theme === 'dark' ? '#424242' : '#f3f4f6',
    textPrimary: theme === 'dark' ? '#eee' : '#24292e',
    textSecondary: theme === 'dark' ? '#bdbdbd' : '#586069',
    textTertiary: theme === 'dark' ? '#999' : '#666',
    border: theme === 'dark' ? '#424242' : '#e1e4e8',
    primary: theme === 'dark' ? '#4caf50' : '#1a7f37',
    accent: theme === 'dark' ? '#64b5f6' : '#2196F3',
    success: theme === 'dark' ? '#81c784' : '#4CAF50',
    warning: theme === 'dark' ? '#ffb74d' : '#FF9800',
  };

  const getProgressColor = (completed: number, goal: number) => {
    if (goal === 0) return themeStyles.textTertiary;
    const percentage = (completed / goal) * 100;
    if (percentage >= 100) return themeStyles.success;
    if (percentage >= 50) return themeStyles.warning;
    return themeStyles.accent;
  };

  return (
    <div style={{
      minHeight: '100vh',
      padding: '40px 20px',
      background: themeStyles.bgPrimary,
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
      }}>
        <div style={{
          marginBottom: '30px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        }}>
          <div>
            <h1 style={{
              fontSize: '28px',
              fontWeight: 'bold',
              color: themeStyles.textPrimary,
              marginBottom: '10px',
            }}>
              {i18n('My Tasks')}
            </h1>
            <p style={{
              fontSize: '14px',
              color: themeStyles.textSecondary,
            }}>
              {i18n('Daily task completion and consecutive days for each domain')}
            </p>
          </div>
          {domainTasks.length > 0 && (
            <a
              href={typeof (window as any).UserContext?._id === 'number'
                ? `/d/${currentDomainId || domainTasks[0].domainId}/user/${(window as any).UserContext._id}/learn`
                : '#'}
              style={{
                padding: '12px 20px',
                borderRadius: '8px',
                background: themeStyles.accent,
                color: '#fff',
                fontSize: '14px',
                fontWeight: 600,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {i18n('All Domains Learn') || '全域学习'}
            </a>
          )}
        </div>

        {domainTasks.length > 0 && (
          <div style={{
            marginBottom: '30px',
            padding: '24px',
            background: themeStyles.bgSecondary,
            borderRadius: '12px',
            border: `1px solid ${themeStyles.border}`,
          }}>
            <h2 style={{
              fontSize: '20px',
              fontWeight: 'bold',
              color: themeStyles.textPrimary,
              marginBottom: '20px',
            }}>
              {i18n('Overall Summary')}
            </h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '20px',
            }}>
              <div style={{
                padding: '16px',
                background: themeStyles.bgPrimary,
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
              }}>
                <div style={{
                  fontSize: '14px',
                  color: themeStyles.textSecondary,
                  marginBottom: '8px',
                }}>
                  {i18n('Total Domains')}
                </div>
                <div style={{
                  fontSize: '32px',
                  fontWeight: 'bold',
                  color: themeStyles.accent,
                }}>
                  {summary.totalDomains}
                </div>
              </div>
              <div style={{
                padding: '16px',
                background: themeStyles.bgPrimary,
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
              }}>
                <div style={{
                  fontSize: '14px',
                  color: themeStyles.textSecondary,
                  marginBottom: '8px',
                }}>
                  {i18n('Total Daily Goal')}
                </div>
                <div style={{
                  fontSize: '32px',
                  fontWeight: 'bold',
                  color: themeStyles.textPrimary,
                }}>
                  {summary.totalDailyGoal}
                </div>
              </div>
              <div style={{
                padding: '16px',
                background: themeStyles.bgPrimary,
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
              }}>
                <div style={{
                  fontSize: '14px',
                  color: themeStyles.textSecondary,
                  marginBottom: '8px',
                }}>
                  {i18n('Today Completed')}
                </div>
                <div style={{
                  fontSize: '32px',
                  fontWeight: 'bold',
                  color: summary.totalTodayCompleted >= summary.totalDailyGoal && summary.totalDailyGoal > 0 
                    ? themeStyles.success 
                    : themeStyles.textPrimary,
                }}>
                  {summary.totalTodayCompleted}
                </div>
                {summary.totalDailyGoal > 0 && (
                  <div style={{
                    marginTop: '8px',
                    width: '100%',
                    height: '6px',
                    background: themeStyles.bgSecondary,
                    borderRadius: '3px',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${Math.min((summary.totalTodayCompleted / summary.totalDailyGoal) * 100, 100)}%`,
                      height: '100%',
                      background: getProgressColor(summary.totalTodayCompleted, summary.totalDailyGoal),
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                )}
              </div>
              <div style={{
                padding: '16px',
                background: themeStyles.bgPrimary,
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
              }}>
                <div style={{
                  fontSize: '14px',
                  color: themeStyles.textSecondary,
                  marginBottom: '8px',
                }}>
                  {i18n('Max Consecutive Days')}
                </div>
                <div style={{
                  fontSize: '32px',
                  fontWeight: 'bold',
                  color: themeStyles.accent,
                }}>
                  {summary.maxConsecutiveDays}
                </div>
              </div>
            </div>
          </div>
        )}

        {domainTasks.length === 0 ? (
          <div style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: themeStyles.textTertiary,
          }}>
            <p style={{ fontSize: '16px', marginBottom: '10px' }}>
              {i18n('No domains found')}
            </p>
            <p style={{ fontSize: '14px' }}>
              {i18n('Please join a domain first')}
            </p>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '20px',
          }}>
            {domainTasks.map((task) => {
              const progressPercentage = task.dailyGoal > 0 
                ? Math.min((task.todayCompleted / task.dailyGoal) * 100, 100) 
                : 0;
              const isCompleted = task.dailyGoal > 0 && task.todayCompleted >= task.dailyGoal;
              
              return (
                <div
                  key={task.domainId}
                  style={{
                    padding: '24px',
                    background: themeStyles.bgSecondary,
                    borderRadius: '12px',
                    border: `1px solid ${themeStyles.border}`,
                    transition: 'transform 0.2s, box-shadow 0.2s',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                  onClick={() => {
                    window.location.href = `/d/${task.domainId}/learn`;
                  }}
                >
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    marginBottom: '20px',
                  }}>
                    <img
                      src={task.domainAvatar}
                      alt={task.domainName}
                      style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '8px',
                        marginRight: '12px',
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{
                        fontSize: '16px',
                        fontWeight: 'bold',
                        color: themeStyles.textPrimary,
                        marginBottom: '4px',
                      }}>
                        {task.domainName}
                      </div>
                      <div style={{
                        fontSize: '12px',
                        color: themeStyles.textSecondary,
                      }}>
                        {task.domainId}
                      </div>
                    </div>
                  </div>

                  <div style={{
                    marginBottom: '20px',
                  }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '8px',
                    }}>
                      <span style={{
                        fontSize: '14px',
                        color: themeStyles.textSecondary,
                      }}>
                        {i18n('Daily Goal')}
                      </span>
                      <span style={{
                        fontSize: '16px',
                        fontWeight: 'bold',
                        color: isCompleted ? themeStyles.success : themeStyles.textPrimary,
                      }}>
                        {task.todayCompleted} / {task.dailyGoal || i18n('Not Set')}
                      </span>
                    </div>
                    {task.dailyGoal > 0 && (
                      <div style={{
                        width: '100%',
                        height: '8px',
                        background: themeStyles.bgPrimary,
                        borderRadius: '4px',
                        overflow: 'hidden',
                        border: `1px solid ${themeStyles.border}`,
                      }}>
                        <div style={{
                          width: `${progressPercentage}%`,
                          height: '100%',
                          background: getProgressColor(task.todayCompleted, task.dailyGoal),
                          transition: 'width 0.3s ease',
                        }} />
                      </div>
                    )}
                  </div>

                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: '16px',
                    borderTop: `1px solid ${themeStyles.border}`,
                  }}>
                    <div>
                      <div style={{
                        fontSize: '12px',
                        color: themeStyles.textSecondary,
                        marginBottom: '4px',
                      }}>
                        {i18n('Consecutive Days')}
                      </div>
                      <div style={{
                        fontSize: '24px',
                        fontWeight: 'bold',
                        color: themeStyles.accent,
                      }}>
                        {task.consecutiveDays}
                      </div>
                    </div>
                    <div style={{
                      fontSize: '14px',
                      color: themeStyles.textSecondary,
                    }}>
                      {i18n('Click to start learning')} →
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('userTaskPage', async () => {
  try {
    const container = document.getElementById('user-task-container');
    if (!container) {
      return;
    }
    ReactDOM.render(<UserTaskPage />, container);
  } catch (error: any) {
    console.error('Failed to render user task page:', error);
  }
});

export default page;
