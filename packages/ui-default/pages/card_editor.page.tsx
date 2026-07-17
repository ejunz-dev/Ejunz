import $ from 'jquery';
import React from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { CardEditorMode } from 'vj/components/base/CardEditor';

const page = new NamedPage('card_editor', async () => {
  const $container = $('#card-editor-mode');
  if (!$container.length) return;

  const cardData = (window as any).UiContext?.card;
  const baseData = (window as any).UiContext?.base;
  const sessionId = (window as any).UiContext?.sessionId || '';
  const nodeId = (window as any).UiContext?.nodeId || '';
  const domainId = (window as any).UiContext?.domainId || 'system';

  if (!cardData) {
    $container.html('<p style="padding: 20px; color: #888;">Card data not available</p>');
    return;
  }

  ReactDOM.render(
    <CardEditorMode
      initialCard={cardData}
      base={baseData}
      sessionId={sessionId}
      nodeId={nodeId}
      domainId={domainId}
    />,
    $container[0],
  );
});

export default page;
