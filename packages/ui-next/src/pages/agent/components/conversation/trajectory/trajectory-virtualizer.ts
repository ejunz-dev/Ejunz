import { useMemo } from 'react'

interface VirtualizerOptions {
  [key: string]: unknown
  count: number
  estimateSize: (index: number) => number
  getItemKey?: (index: number) => string | number
  getScrollElement: () => HTMLElement | null
  enabled?: boolean
  scrollMargin?: number
}

export interface VirtualItem {
  index: number
  key: string | number
  start: number
  end: number
}

export function useVirtualizer<TScroll = HTMLElement, TItem = HTMLElement>(options: VirtualizerOptions) {
  const items = useMemo<VirtualItem[]>(() => {
    if (options.enabled === false) return []
    let start = options.scrollMargin ?? 0
    return Array.from({ length: options.count }, (_, index) => {
      const end = start + options.estimateSize(index)
      const item = {
        index,
        key: options.getItemKey?.(index) ?? index,
        start,
        end,
      }
      start = end
      return item
    })
  }, [options])
  const total = items.at(-1)?.end ?? options.scrollMargin ?? 0
  return {
    getVirtualItems: () => items,
    getTotalSize: () => total,
    scrollToIndex: (index: number, _options?: unknown) => {
      const element = options.getScrollElement()
      const item = items[index]
      if (element !== null && item !== undefined) element.scrollTop = item.start
    },
    scrollToEnd: (_options?: unknown) => {
      const element = options.getScrollElement()
      if (element !== null) element.scrollTop = element.scrollHeight
    },
  }
}
