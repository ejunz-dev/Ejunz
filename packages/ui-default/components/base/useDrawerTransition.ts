import { useEffect, useState } from 'react';

export const BASE_DETAIL_DRAWER_TRANSITION_MS = 240;

export function useDrawerTransition(open: boolean, durationMs = BASE_DETAIL_DRAWER_TRANSITION_MS) {
  const [visible, setVisible] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
      return undefined;
    }
    if (!visible) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
      setClosing(false);
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, open, visible]);

  return { visible, closing };
}
