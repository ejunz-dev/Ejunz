import { useEffect, useState } from 'react';
import { Card } from '../card';
import { i18n } from '../../i18n';

const HITOKOTO_URL = 'https://v1.hitokoto.cn?c=a&c=b&c=c&c=d&c=e&c=f';

export function HitokotoWidget() {
  const [quote, setQuote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(HITOKOTO_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ hitokoto?: string }>;
      })
      .then((payload) => {
        if (!cancelled) setQuote(payload.hitokoto || i18n('Cannot get hitokoto.'));
      })
      .catch(() => {
        if (!cancelled) setQuote(i18n('Cannot get hitokoto.'));
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <Card title={i18n('Hitokoto')}>
      <p className="uix-hitokoto">{quote || i18n('Loading...')}</p>
    </Card>
  );
}

const suggestionGroups = [
  { key: 'Chinese', label: 'Chinese' },
  { key: 'English', label: 'English' },
  { key: 'Tools', label: 'Tools' },
] as const;

export function SuggestionWidget() {
  return (
    <Card title={i18n('Recommended')}>
      <div className="uix-suggestion-groups">
        {suggestionGroups.map(({ key, label }) => (
          <section className="uix-suggestion-group" key={key}>
            <h3>{i18n(label)}</h3>
            <ol aria-label={i18n(label)} />
          </section>
        ))}
      </div>
    </Card>
  );
}
