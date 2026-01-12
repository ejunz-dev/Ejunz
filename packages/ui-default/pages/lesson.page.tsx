import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

interface Problem {
  pid: string;
  type: 'single';
  stem: string;
  options: string[];
  answer: number;
  analysis?: string;
}

interface Card {
  docId: string;
  title: string;
  content: string;
  problems?: Problem[];
}

interface Node {
  id: string;
  text: string;
}

function LessonPage() {
  const card = (window.UiContext?.card || {}) as Card;
  const node = (window.UiContext?.node || {}) as Node;
  const cards = (window.UiContext?.cards || []) as Card[];
  const currentIndex = (window.UiContext?.currentIndex || 0) as number;
  const domainId = (window.UiContext?.domainId || '') as string;
  const mindMapDocId = (window.UiContext?.mindMapDocId || '') as string;

  const allProblems = useMemo(() => {
    return (card.problems || []).map(p => ({ ...p, cardId: card.docId }));
  }, [card]);

  const [problemQueue, setProblemQueue] = useState<Array<Problem & { cardId: string }>>(allProblems);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [isPassed, setIsPassed] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [answerHistory, setAnswerHistory] = useState<Array<{ problem: Problem & { cardId: string }; selected: number; correct: boolean }>>([]);

  useEffect(() => {
    if (allProblems.length > 0 && problemQueue.length === 0 && answerHistory.length === 0) {
      setProblemQueue(allProblems);
      setCurrentProblemIndex(0);
      setSelectedAnswer(null);
      setIsAnswered(false);
      setShowAnalysis(false);
    }
  }, [allProblems, problemQueue.length, answerHistory.length]);

  const currentProblem = problemQueue[currentProblemIndex];
  const isCorrect = currentProblem && selectedAnswer === currentProblem.answer;
  const allCorrect = problemQueue.length === 0 && answerHistory.length > 0;

  useEffect(() => {
    if (currentProblem) {
      setSelectedAnswer(null);
      setIsAnswered(false);
      setShowAnalysis(false);
    }
  }, [currentProblemIndex, currentProblem]);

  const handlePass = async () => {
    if (isPassed) return;
    try {
      await request.post(`/d/${domainId}/learn/lesson/pass`, {});
      setIsPassed(true);
    } catch (error: any) {
    }
  };

  useEffect(() => {
    if (allCorrect && !isPassed && allProblems.length > 0) {
      handlePass();
    }
  }, [allCorrect, isPassed, allProblems.length, domainId, node.id, card.docId]);

  const handleAnswerSelect = (answerIndex: number) => {
    if (isAnswered || !currentProblem) return;
    const isCorrect = answerIndex === currentProblem.answer;
    setSelectedAnswer(answerIndex);
    setIsAnswered(true);
    setShowAnalysis(true);

    setAnswerHistory(prev => [...prev, {
      problem: currentProblem,
      selected: answerIndex,
      correct: isCorrect,
    }]);

    if (isCorrect) {
      setTimeout(() => {
        handleNextProblem();
      }, 1500);
    } else {
      setTimeout(() => {
        handleWrongAnswer();
      }, 2000);
    }
  };

  const handleNextProblem = () => {
    setSelectedAnswer(null);
    setIsAnswered(false);
    setShowAnalysis(false);
    
    const newQueue = [...problemQueue];
    newQueue.splice(currentProblemIndex, 1);
    setProblemQueue(newQueue);
    
    if (newQueue.length > 0) {
      const nextIndex = currentProblemIndex < newQueue.length ? currentProblemIndex : 0;
      setCurrentProblemIndex(nextIndex);
    } else {
      setCurrentProblemIndex(0);
    }
  };

  const handleWrongAnswer = () => {
    setSelectedAnswer(null);
    setIsAnswered(false);
    setShowAnalysis(false);
    
    const newQueue = [...problemQueue];
    const wrongProblem = newQueue[currentProblemIndex];
    newQueue.splice(currentProblemIndex, 1);
    newQueue.push(wrongProblem);
    setProblemQueue(newQueue);
    
    const nextIndex = currentProblemIndex < newQueue.length - 1 ? currentProblemIndex : 0;
    setCurrentProblemIndex(nextIndex);
  };

  if (allCorrect) {
    const correctCount = answerHistory.filter(h => h.correct).length;
    const totalCount = allProblems.length;
    const accuracy = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

    return (
      <div style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
      }}>
        <div style={{
          marginBottom: '20px',
          padding: '16px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
        }}>
          <div style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
            {node.text || i18n('Unnamed Node')}
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
            {card.title || i18n('Unnamed Card')}
          </h1>
        </div>

        {card.content && (
          <div style={{
            marginBottom: '30px',
            padding: '20px',
            backgroundColor: '#fff',
            borderRadius: '8px',
            border: '1px solid #e0e0e0',
          }}>
            <h2 style={{ fontSize: '18px', marginBottom: '12px', color: '#333' }}>
              {i18n('Content')}
            </h2>
            <div
              style={{
                fontSize: '16px',
                lineHeight: '1.6',
                color: '#555',
              }}
              dangerouslySetInnerHTML={{ __html: card.content }}
            />
          </div>
        )}

        <div style={{
          marginBottom: '30px',
          padding: '30px',
          backgroundColor: '#fff',
          borderRadius: '8px',
          border: '1px solid #e0e0e0',
        }}>
          <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#333' }}>
            {i18n('Practice Results')}
          </h2>
          <div style={{
            display: 'flex',
            justifyContent: 'space-around',
            marginBottom: '30px',
            padding: '20px',
            backgroundColor: '#f5f5f5',
            borderRadius: '8px',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#4caf50', marginBottom: '8px' }}>
                {correctCount}/{totalCount}
              </div>
              <div style={{ fontSize: '14px', color: '#666' }}>{i18n('Correct')}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#2196f3', marginBottom: '8px' }}>
                {accuracy}%
              </div>
              <div style={{ fontSize: '14px', color: '#666' }}>{i18n('Accuracy')}</div>
            </div>
          </div>

          <div style={{ marginTop: '20px' }}>
            {answerHistory.map((history, idx) => (
              <div
                key={idx}
                style={{
                  padding: '12px',
                  marginBottom: '12px',
                  borderRadius: '6px',
                  backgroundColor: history.correct ? '#e8f5e9' : '#ffebee',
                  border: `1px solid ${history.correct ? '#4caf50' : '#f44336'}`,
                }}
              >
                <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>
                  {i18n('Question')} {idx + 1}: {history.problem.stem}
                </div>
                <div style={{ fontSize: '12px', color: '#666' }}>
                  {i18n('Your Answer')}: {history.problem.options[history.selected]} 
                  {history.correct ? (
                    <span style={{ color: '#4caf50', marginLeft: '8px' }}>✓</span>
                  ) : (
                    <span style={{ color: '#f44336', marginLeft: '8px' }}>✗</span>
                  )}
                </div>
                {!history.correct && (
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    {i18n('Correct Answer')}: {history.problem.options[history.problem.answer]}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {isPassed ? (
          <div style={{
            textAlign: 'center',
            padding: '20px',
          }}>
            <div style={{
              padding: '40px',
              backgroundColor: '#e8f5e9',
              borderRadius: '12px',
              border: '2px solid #4caf50',
              marginBottom: '20px',
            }}>
              <div style={{ fontSize: '48px', marginBottom: '20px' }}>✓</div>
              <h2 style={{ fontSize: '28px', color: '#2e7d32', marginBottom: '16px' }}>
                {i18n('Lesson Passed')}
              </h2>
              <p style={{ fontSize: '16px', color: '#555', marginBottom: '30px' }}>
                {i18n('Congratulations! You have completed all practice questions correctly.')}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => {
                  window.location.href = `/d/${domainId}/learn/lesson`;
                }}
                style={{
                  padding: '12px 32px',
                  border: 'none',
                  borderRadius: '6px',
                  backgroundColor: '#2196f3',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}
              >
                {i18n('Next Card')}
              </button>
              <button
                onClick={() => {
                  window.location.href = `/d/${domainId}/learn`;
                }}
                style={{
                  padding: '12px 32px',
                  border: 'none',
                  borderRadius: '6px',
                  backgroundColor: '#4caf50',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}
              >
                {i18n('Back to Learn')}
              </button>
            </div>
          </div>
        ) : (
          <div style={{
            textAlign: 'center',
            padding: '20px',
          }}>
            <div style={{
              padding: '20px',
              backgroundColor: '#fff3cd',
              borderRadius: '8px',
              border: '1px solid #ffc107',
              color: '#856404',
            }}>
              {i18n('Saving progress...')}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!currentProblem && !allCorrect && answerHistory.length === 0) {
    return (
      <div style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        textAlign: 'center',
      }}>
        <div style={{
          padding: '40px',
          color: '#999',
        }}>
          {i18n('No content or practice questions available.')}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      maxWidth: '900px',
      margin: '0 auto',
      padding: '20px',
    }}>
      <div style={{
        marginBottom: '20px',
        padding: '16px',
        backgroundColor: '#f5f5f5',
        borderRadius: '8px',
      }}>
        <div style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
          {node.text || i18n('Unnamed Node')}
        </div>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
          {card.title || i18n('Unnamed Card')}
        </h1>
        <div style={{ fontSize: '12px', color: '#999', marginTop: '8px' }}>
          {i18n('Question')} {allProblems.length - problemQueue.length + 1} / {allProblems.length}
          {problemQueue.length > 0 && ` (${i18n('Remaining')}: ${problemQueue.length})`}
        </div>
      </div>


      <div style={{
        marginBottom: '30px',
        padding: '30px',
        backgroundColor: '#fff',
        borderRadius: '8px',
        border: '1px solid #e0e0e0',
      }}>
        <div style={{ marginBottom: '16px' }}>
          <span style={{
            display: 'inline-block',
            padding: '4px 8px',
            backgroundColor: '#2196f3',
            color: '#fff',
            borderRadius: '4px',
            fontSize: '12px',
            marginRight: '8px',
          }}>
            {i18n('Question')}
          </span>
          {isAnswered && (
            <span style={{
              display: 'inline-block',
              padding: '4px 8px',
              backgroundColor: isCorrect ? '#4caf50' : '#f44336',
              color: '#fff',
              borderRadius: '4px',
              fontSize: '12px',
            }}>
              {isCorrect ? i18n('Correct') : i18n('Incorrect')}
            </span>
          )}
        </div>

        <div style={{
          fontSize: '18px',
          fontWeight: '500',
          marginBottom: '24px',
          color: '#333',
          lineHeight: '1.6',
        }}>
          {currentProblem.stem}
        </div>

        <div style={{ marginBottom: '20px' }}>
          {currentProblem.options.map((option, optIndex) => {
            const isSelected = selectedAnswer === optIndex;
            const isAnswer = optIndex === currentProblem.answer;
            let optionStyle: React.CSSProperties = {
              padding: '14px',
              marginBottom: '12px',
              borderRadius: '6px',
              border: '2px solid #e0e0e0',
              cursor: isAnswered ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              backgroundColor: '#fff',
            };

            if (showAnalysis) {
              if (isAnswer) {
                optionStyle.borderColor = '#4caf50';
                optionStyle.backgroundColor = '#e8f5e9';
              } else if (isSelected) {
                optionStyle.borderColor = '#f44336';
                optionStyle.backgroundColor = '#ffebee';
              } else {
                optionStyle.opacity = 0.6;
              }
            } else if (isSelected) {
              optionStyle.borderColor = '#2196f3';
              optionStyle.backgroundColor = '#e3f2fd';
            }

            return (
              <div
                key={`${currentProblem?.pid || currentProblemIndex}-${optIndex}`}
                onClick={() => !isAnswered && handleAnswerSelect(optIndex)}
                style={optionStyle}
              >
                <span style={{ marginRight: '10px', fontWeight: 'bold', fontSize: '16px' }}>
                  {String.fromCharCode(65 + optIndex)}.
                </span>
                <span style={{ fontSize: '16px' }}>{option}</span>
              </div>
            );
          })}
        </div>

        {showAnalysis && currentProblem.analysis && (
          <div style={{
            marginTop: '20px',
            padding: '16px',
            backgroundColor: '#f5f5f5',
            borderRadius: '6px',
            fontSize: '15px',
            color: '#666',
            lineHeight: '1.6',
          }}>
            <strong style={{ color: '#333' }}>{i18n('Analysis')}:</strong> {currentProblem.analysis}
          </div>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('lessonPage', async () => {
  try {
    const container = document.getElementById('lesson-container');
    if (!container) {
      return;
    }
    ReactDOM.render(<LessonPage />, container);
  } catch (error: any) {
  }
});

export default page;
