import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

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

  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [showAnswers, setShowAnswers] = useState<Record<string, boolean>>({});

  const handleAnswerSelect = (problemId: string, answerIndex: number) => {
    setSelectedAnswers({
      ...selectedAnswers,
      [problemId]: answerIndex,
    });
  };

  const toggleShowAnswer = (problemId: string) => {
    setShowAnswers({
      ...showAnswers,
      [problemId]: !showAnswers[problemId],
    });
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      const prevCard = cards[currentIndex - 1];
      window.location.href = `/learn/lesson/${domainId}/${node.id}/${prevCard.docId}`;
    }
  };

  const handleNext = () => {
    if (currentIndex < cards.length - 1) {
      const nextCard = cards[currentIndex + 1];
      window.location.href = `/learn/lesson/${domainId}/${node.id}/${nextCard.docId}`;
    }
  };

  const problems = card.problems || [];

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
          {currentIndex + 1} / {cards.length}
        </div>
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

      {problems.length > 0 && (
        <div style={{ marginBottom: '30px' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '16px', color: '#333' }}>
            {i18n('Practice Questions')} ({problems.length})
          </h2>
          {problems.map((problem, index) => {
            const isCorrect = selectedAnswers[problem.pid] === problem.answer;
            const isAnswered = selectedAnswers[problem.pid] !== undefined;
            const showAnswer = showAnswers[problem.pid];

            return (
              <div
                key={problem.pid}
                style={{
                  marginBottom: '20px',
                  padding: '20px',
                  backgroundColor: '#fff',
                  borderRadius: '8px',
                  border: '1px solid #e0e0e0',
                }}
              >
                <div style={{ marginBottom: '12px' }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '4px 8px',
                    backgroundColor: '#2196f3',
                    color: '#fff',
                    borderRadius: '4px',
                    fontSize: '12px',
                    marginRight: '8px',
                  }}>
                    {i18n('Question')} {index + 1}
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
                  fontSize: '16px',
                  fontWeight: '500',
                  marginBottom: '16px',
                  color: '#333',
                }}>
                  {problem.stem}
                </div>

                <div style={{ marginBottom: '12px' }}>
                  {problem.options.map((option, optIndex) => {
                    const isSelected = selectedAnswers[problem.pid] === optIndex;
                    const isAnswer = optIndex === problem.answer;
                    let optionStyle: React.CSSProperties = {
                      padding: '12px',
                      marginBottom: '8px',
                      borderRadius: '6px',
                      border: '2px solid #e0e0e0',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      backgroundColor: '#fff',
                    };

                    if (isSelected) {
                      optionStyle.borderColor = '#2196f3';
                      optionStyle.backgroundColor = '#e3f2fd';
                    }

                    if (showAnswer && isAnswer) {
                      optionStyle.borderColor = '#4caf50';
                      optionStyle.backgroundColor = '#e8f5e9';
                    }

                    if (showAnswer && isSelected && !isCorrect) {
                      optionStyle.borderColor = '#f44336';
                      optionStyle.backgroundColor = '#ffebee';
                    }

                    return (
                      <div
                        key={optIndex}
                        onClick={() => handleAnswerSelect(problem.pid, optIndex)}
                        style={optionStyle}
                      >
                        <span style={{ marginRight: '8px', fontWeight: 'bold' }}>
                          {String.fromCharCode(65 + optIndex)}.
                        </span>
                        {option}
                      </div>
                    );
                  })}
                </div>

                {showAnswer && problem.analysis && (
                  <div style={{
                    marginTop: '12px',
                    padding: '12px',
                    backgroundColor: '#f5f5f5',
                    borderRadius: '6px',
                    fontSize: '14px',
                    color: '#666',
                  }}>
                    <strong>{i18n('Analysis')}:</strong> {problem.analysis}
                  </div>
                )}

                <button
                  onClick={() => toggleShowAnswer(problem.pid)}
                  style={{
                    marginTop: '12px',
                    padding: '8px 16px',
                    border: '1px solid #2196f3',
                    borderRadius: '6px',
                    backgroundColor: showAnswer ? '#f5f5f5' : '#2196f3',
                    color: showAnswer ? '#333' : '#fff',
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  {showAnswer ? i18n('Hide Answer') : i18n('Show Answer')}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {problems.length === 0 && !card.content && (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          color: '#999',
        }}>
          {i18n('No content or practice questions available.')}
        </div>
      )}

      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: '30px',
        paddingTop: '20px',
        borderTop: '1px solid #e0e0e0',
      }}>
        <button
          onClick={handlePrev}
          disabled={currentIndex === 0}
          style={{
            padding: '12px 24px',
            border: '1px solid #ddd',
            borderRadius: '6px',
            backgroundColor: currentIndex === 0 ? '#f5f5f5' : '#fff',
            color: currentIndex === 0 ? '#999' : '#333',
            cursor: currentIndex === 0 ? 'not-allowed' : 'pointer',
            fontSize: '16px',
          }}
        >
          {i18n('Previous')}
        </button>
        <button
          onClick={handleNext}
          disabled={currentIndex >= cards.length - 1}
          style={{
            padding: '12px 24px',
            border: '1px solid #4caf50',
            borderRadius: '6px',
            backgroundColor: currentIndex >= cards.length - 1 ? '#f5f5f5' : '#4caf50',
            color: currentIndex >= cards.length - 1 ? '#999' : '#fff',
            cursor: currentIndex >= cards.length - 1 ? 'not-allowed' : 'pointer',
            fontSize: '16px',
          }}
        >
          {i18n('Next')}
        </button>
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
