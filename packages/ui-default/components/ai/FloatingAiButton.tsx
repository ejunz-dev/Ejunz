import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import $ from 'jquery';
import AiDialog from './AiDialog';

export default function FloatingAiButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <div 
        className="floating-ai-button"
        onClick={() => setIsOpen(true)}
        title="AI助手"
      >
        <span className="icon icon-bot"></span>
      </div>
      {isOpen && (
        <AiDialog 
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}

export function initFloatingAiButton() {
  const container = document.createElement('div');
  container.id = 'floating-ai-button-container';
  document.body.appendChild(container);
  
  ReactDOM.render(<FloatingAiButton />, container);
}

