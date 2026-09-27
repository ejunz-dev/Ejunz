import type { ReactNode } from 'react'
import { IconSearchOutline16, IconSettingsOutline16 } from '../../../icons'
import { MarkdownText } from '../../primitives/markdown/MarkdownText'

export { IconSearchOutline16, IconSettingsOutline16, MarkdownText }

export function IconChevronRightOutline14({ size = 14, className }: { size?: number; className?: string }) {
  return <span className={className} style={{ display: 'inline-flex', width: size, height: size }}>›</span>
}

export function IconSparkle16({ size = 16, className }: { size?: number; className?: string }) {
  return <span className={className} style={{ fontSize: size, lineHeight: 1 }}>✦</span>
}

export function IconUserOutline16({ size = 16, className }: { size?: number; className?: string }) {
  return <span className={className} style={{ fontSize: size, lineHeight: 1 }}>●</span>
}

export function JsonTree({ data, label, className }: { data: unknown; label: string; className?: string }) {
  return <pre className={className} aria-label={label}>{JSON.stringify(data, null, 2)}</pre>
}

export function Tooltip({ children, label }: { children: ReactNode; label: string | (() => string); side?: string; delayMs?: number }) {
  const value = typeof label === 'function' ? label() : label
  return <span title={value}>{children}</span>
}
