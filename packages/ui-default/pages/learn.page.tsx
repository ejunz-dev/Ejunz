import React, { useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import { request } from 'vj/utils';
import moment from 'moment';

function LearnPage() {
  const domainId = (window as any).UiContext?.domainId as string;
  const currentProgress = (window as any).UiContext?.currentProgress || 0;
  const totalCards = (window as any).UiContext?.totalCards || 0;
  const consecutiveDays = (window as any).UiContext?.consecutiveDays || 0;
  const dailyGoal = (window as any).UiContext?.dailyGoal || 0;
  const nextCard = (window as any).UiContext?.nextCard as { nodeId: string; cardId: string } | null;

  const [goal, setGoal] = useState(dailyGoal);
  const [isEditingGoal, setIsEditingGoal] = useState(false);
  const [isSavingGoal, setIsSavingGoal] = useState(false);

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
  };

  const handleStart = useCallback(() => {
    if (nextCard) {
      window.location.href = `/d/${domainId}/learn/lesson?cardId=${nextCard.cardId}`;
    } else {
      window.location.href = `/d/${domainId}/learn/lesson`;
    }
  }, [domainId, nextCard]);

  const handleSaveGoal = useCallback(async () => {
    if (isSavingGoal) return;
    setIsSavingGoal(true);
    try {
      await request.post(`/d/${domainId}/learn/daily-goal`, {
        dailyGoal: goal,
      });
      setIsEditingGoal(false);
    } catch (error: any) {
      console.error('Failed to save daily goal:', error);
      alert(i18n('Failed to save daily goal'));
    } finally {
      setIsSavingGoal(false);
    }
  }, [domainId, goal, isSavingGoal]);

  const progressPercentage = totalCards > 0 ? Math.round((currentProgress / totalCards) * 100) : 0;

  return (
    <div style={{
      minHeight: '100vh',
      padding: '40px 20px',
      background: themeStyles.bgPrimary,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        maxWidth: '600px',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '30px',
      }}>
        <div style={{
          textAlign: 'center',
          marginBottom: '20px',
        }}>
          <h1 style={{
            fontSize: '32px',
            fontWeight: 'bold',
            color: themeStyles.textPrimary,
            marginBottom: '10px',
          }}>
            {i18n('Learning Progress')}
          </h1>
        </div>

        <div style={{
          padding: '30px',
          background: themeStyles.bgSecondary,
          borderRadius: '12px',
          border: `1px solid ${themeStyles.border}`,
        }}>
          <div style={{
            marginBottom: '20px',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '10px',
            }}>
              <span style={{
                fontSize: '16px',
                color: themeStyles.textSecondary,
              }}>
                {i18n('Progress')}
              </span>
              <span style={{
                fontSize: '18px',
                fontWeight: 'bold',
                color: themeStyles.textPrimary,
              }}>
                {currentProgress} / {totalCards}
              </span>
            </div>
            <div style={{
              width: '100%',
              height: '24px',
              background: themeStyles.bgPrimary,
              borderRadius: '12px',
              overflow: 'hidden',
              border: `1px solid ${themeStyles.border}`,
            }}>
              <div style={{
                width: `${progressPercentage}%`,
                height: '100%',
                background: themeStyles.primary,
                transition: 'width 0.3s ease',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {progressPercentage > 10 && (
                  <span style={{
                    fontSize: '12px',
                    color: '#fff',
                    fontWeight: 'bold',
                  }}>
                    {progressPercentage}%
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{
            textAlign: 'center',
            padding: '30px 0',
            borderTop: `1px solid ${themeStyles.border}`,
            borderBottom: `1px solid ${themeStyles.border}`,
            margin: '30px 0',
          }}>
            <div style={{
              fontSize: '48px',
              fontWeight: 'bold',
              color: themeStyles.accent,
              marginBottom: '10px',
            }}>
              {consecutiveDays}
            </div>
            <div style={{
              fontSize: '18px',
              color: themeStyles.textSecondary,
            }}>
              {i18n('Consecutive Days')}
            </div>
          </div>

          <div style={{
            marginTop: '20px',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '15px',
            }}>
              <span style={{
                fontSize: '16px',
                color: themeStyles.textSecondary,
              }}>
                {i18n('Daily Goal')}
              </span>
              {!isEditingGoal && (
                <button
                  onClick={() => setIsEditingGoal(true)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '14px',
                    background: 'transparent',
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '6px',
                    color: themeStyles.textPrimary,
                    cursor: 'pointer',
                  }}
                >
                  {i18n('Edit')}
                </button>
              )}
            </div>
            {isEditingGoal ? (
              <div style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'center',
              }}>
                <input
                  type="number"
                  value={goal}
                  onChange={(e) => setGoal(parseInt(e.target.value, 10) || 0)}
                  min="0"
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    fontSize: '16px',
                    background: themeStyles.bgPrimary,
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '6px',
                    color: themeStyles.textPrimary,
                  }}
                />
                <span style={{
                  fontSize: '14px',
                  color: themeStyles.textSecondary,
                }}>
                  {i18n('cards')}
                </span>
                <button
                  onClick={handleSaveGoal}
                  disabled={isSavingGoal}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    background: themeStyles.primary,
                    border: 'none',
                    borderRadius: '6px',
                    color: '#fff',
                    cursor: isSavingGoal ? 'not-allowed' : 'pointer',
                    opacity: isSavingGoal ? 0.6 : 1,
                  }}
                >
                  {isSavingGoal ? i18n('Saving...') : i18n('Save')}
                </button>
                <button
                  onClick={() => {
                    setIsEditingGoal(false);
                    setGoal(dailyGoal);
                  }}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    background: 'transparent',
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '6px',
                    color: themeStyles.textPrimary,
                    cursor: 'pointer',
                  }}
                >
                  {i18n('Cancel')}
                </button>
              </div>
            ) : (
              <div style={{
                fontSize: '24px',
                fontWeight: 'bold',
                color: themeStyles.textPrimary,
              }}>
                {dailyGoal} {i18n('cards')}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={handleStart}
          style={{
            padding: '16px 32px',
            fontSize: '18px',
            fontWeight: 'bold',
            background: themeStyles.primary,
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            width: '100%',
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '0.9';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '1';
          }}
        >
          {i18n('Start Learning')}
        </button>
      </div>
    </div>
  );
}

const page = new NamedPage('learnPage', async () => {
  try {
    const container = document.getElementById('learn-container');
    if (!container) {
      return;
    }
    ReactDOM.render(<LearnPage />, container);
  } catch (error: any) {
    console.error('Failed to render learn page:', error);
  }
});

export default page;
