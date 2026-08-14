import { createPortal } from 'react-dom';
import { useEffect, useState, type ReactNode } from 'react';
import './notification.css';

export type NotificationType = 'success' | 'info' | 'warn' | 'error';
export type NotificationPosition = 'bottom-left' | 'top-right';

export interface NotificationOptions {
  message: string;
  title?: string;
  type?: NotificationType;
  duration?: number;
  closable?: boolean;
  position?: NotificationPosition;
  action?: () => void;
}

interface NotificationItem extends Required<Pick<NotificationOptions, 'message' | 'type' | 'position'>> {
  id: number;
  title?: string;
  closable: boolean;
  action?: () => void;
}

const items: NotificationItem[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function remove(id: number) {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return;
  items.splice(index, 1);
  emit();
}

function enqueue(options: NotificationOptions): number {
  const id = nextId++;
  const duration = options.duration ?? 3000;
  items.push({
    id,
    message: options.message,
    title: options.title,
    type: options.type || 'info',
    position: options.position || 'bottom-left',
    closable: options.closable ?? false,
    action: options.action,
  });
  emit();
  if (duration > 0) window.setTimeout(() => remove(id), duration);
  return id;
}

/** React-free notification API matching ui-default's Notification helpers. */
export class Notification {
  static async show(options: NotificationOptions): Promise<number> {
    return enqueue(options);
  }

  static async success(message: string, duration?: number): Promise<number> {
    return enqueue({ message, duration, type: 'success' });
  }

  static async info(message: string, duration?: number): Promise<number> {
    return enqueue({ message, duration, type: 'info' });
  }

  static async warn(message: string, duration?: number): Promise<number> {
    return enqueue({ message, duration, type: 'warn' });
  }

  static async error(message: string, duration?: number): Promise<number> {
    return enqueue({ message, duration, type: 'error' });
  }

  static hide(id: number) {
    remove(id);
  }
}

function NotificationItemView({ item }: { item: NotificationItem }) {
  return (
    <article className={`uix-notification uix-notification--${item.type}`} role={item.type === 'error' ? 'alert' : 'status'} onClick={() => item.action?.()}>
      <div className="uix-notification__content">
        {item.title ? <strong>{item.title}</strong> : null}
        <span>{item.message}</span>
      </div>
      {item.closable ? <button type="button" className="uix-notification__close" aria-label="Close" onClick={(event) => { event.stopPropagation(); Notification.hide(item.id); }}>×</button> : null}
    </article>
  );
}

export function NotificationHost() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribe(() => setVersion((version) => version + 1));
    return () => { unsubscribe(); };
  }, []);
  if (typeof document === 'undefined') return null;
  const grouped = new Map<NotificationPosition, NotificationItem[]>();
  for (const item of items) grouped.set(item.position, [...(grouped.get(item.position) || []), item]);
  return createPortal(
    <>
      {(['bottom-left', 'top-right'] as NotificationPosition[]).map((position) => {
        const group = grouped.get(position) || [];
        if (!group.length) return null;
        return <div className={`uix-notification-stack uix-notification-stack--${position}`} key={position}>{group.map((item) => <NotificationItemView item={item} key={item.id} />)}</div>;
      })}
    </>,
    document.body,
  );
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  return <>{children}<NotificationHost /></>;
}

export default Notification;
