import React, { useCallback, useMemo, useRef, useState } from 'react';
import { i18n } from 'vj/utils';
import type { BaseEdge, BaseNode, Card } from './types';
import { buildBaseTutorSuggestedQuestions } from './ai/suggested_questions';
import { useBaseAiTutorChat } from './ai/useBaseAiTutorChat';

function WandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 4l1 1-9 9-1-1 9-9zM4 20l1.5-1.5M17 3l4 4M19 5l-2 2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 8l1 1M6 11l1 1M11 6l1 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 4h8a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM8 4v13M16 7h3v13h-3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l1.2 4.2L17.5 8.5 13.2 9.7 12 14l-1.2-4.3L6.5 8.5l4.3-1.3L12 3zM5 16l.8 2.8L8.5 19.5 5.8 20.3 5 23l-.8-2.7L1.5 19.5l2.7-.7L5 16z"
        fill="currentColor"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12l16-7-7 16-2-7-7-2z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export type BaseDetailAiTutorProps = {
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  docTitle: string;
  branch: string;
  docDescription?: string;
  selectedNode: BaseNode | null;
  selectedCard: Card | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function BaseDetailAiTutor({
  nodes,
  edges,
  nodeCardsMap,
  docTitle,
  branch,
  docDescription,
  selectedNode,
  selectedCard,
  open: openProp,
  onOpenChange,
}: BaseDetailAiTutorProps) {
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp ?? openInternal;
  const setOpen = onOpenChange ?? setOpenInternal;
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    messages,
    isLoading,
    sendMessage,
    messagesEndRef,
  } = useBaseAiTutorChat({
    nodes,
    edges,
    nodeCardsMap,
    selectedNode,
    selectedCard,
    docTitle,
    branch,
    docDescription,
  });

  const suggestedQuestions = useMemo(
    () => buildBaseTutorSuggestedQuestions(nodes, edges, docTitle),
    [docTitle, edges, nodes],
  );

  const showSuggestions = !messages.some((msg) => msg.role === 'user');

  const handleOpen = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [setOpen]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendMessage(text);
  }, [input, sendMessage]);

  const handleSuggestedClick = useCallback(async (question: string) => {
    await sendMessage(question);
  }, [sendMessage]);

  return (
    <>
      {!open ? (
        <button
          type="button"
          className="roadmap-ai-tutor-bar"
          onClick={handleOpen}
          aria-label={i18n('Roadmap AI tutor open')}
        >
          <span className="roadmap-ai-tutor-bar__brand">
            <WandIcon />
            {i18n('Roadmap AI tutor')}
          </span>
          <span className="roadmap-ai-tutor-bar__hint">{i18n('Roadmap AI tutor bar hint')}</span>
        </button>
      ) : null}

      {open ? (
        <>
          <div
            className="roadmap-ai-tutor-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className="roadmap-ai-tutor-modal"
            role="dialog"
            aria-modal="true"
            aria-label={i18n('Roadmap AI tutor')}
          >
            <div className="roadmap-ai-tutor-modal__header">
              <div className="roadmap-ai-tutor-modal__title">
                <BookIcon />
                {i18n('Roadmap AI tutor')}
              </div>
              <button
                type="button"
                className="roadmap-ai-tutor-modal__close"
                onClick={() => setOpen(false)}
                aria-label={i18n('Close')}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="roadmap-ai-tutor-modal__body">
              <div className="roadmap-ai-tutor-greeting">
                <span className="roadmap-ai-tutor-greeting__icon" aria-hidden>
                  <SparkleIcon />
                </span>
                <span>{i18n('Roadmap AI tutor greeting')}</span>
              </div>

              {messages.map((msg, index) => (
                <div
                  key={`${index}-${msg.role}`}
                  className={`roadmap-ai-tutor-msg roadmap-ai-tutor-msg--${msg.role}`}
                >
                  {msg.content || (msg.role === 'assistant' && isLoading ? i18n('Roadmap AI thinking') : '')}
                </div>
              ))}

              {showSuggestions ? (
                <div className="roadmap-ai-tutor-suggestions">
                  <p className="roadmap-ai-tutor-suggestions__lead">
                    {i18n('Roadmap AI tutor suggestions lead')}
                  </p>
                  <div className="roadmap-ai-tutor-suggestions__list">
                    {suggestedQuestions.map((question) => (
                      <button
                        key={question}
                        type="button"
                        className="roadmap-ai-tutor-suggestions__pill"
                        disabled={isLoading}
                        onClick={() => handleSuggestedClick(question)}
                      >
                        {question}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div ref={messagesEndRef} />
            </div>

            <div className="roadmap-ai-tutor-modal__footer">
              <div className="roadmap-ai-tutor-input-wrap">
                <input
                  ref={inputRef}
                  type="text"
                  className="roadmap-ai-tutor-input"
                  value={input}
                  onChange={(e) => setInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder={i18n('Roadmap AI tutor input placeholder')}
                  disabled={isLoading}
                  aria-label={i18n('Roadmap AI tutor input placeholder')}
                />
                <button
                  type="button"
                  className="roadmap-ai-tutor-send"
                  onClick={handleSubmit}
                  disabled={isLoading || !input.trim()}
                  aria-label={i18n('Send')}
                >
                  <SendIcon />
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
