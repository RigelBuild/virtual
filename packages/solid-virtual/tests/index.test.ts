import { expect, test } from 'vitest'
import { createRoot, createSignal, flush } from 'solid-js'

import { createVirtualizer } from '../src/index'

test('preserves measured sizes when reactive options change', () => {
  createRoot((dispose) => {
    // In an app the count signal is written from an event handler (an
    // unowned scope); here the write happens inside createRoot, so opt in.
    const [count, setCount] = createSignal(2, { ownedWrite: true })
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      get count() {
        return count()
      },
      getScrollElement: () => null,
      estimateSize: () => 60,
      initialRect: { width: 800, height: 600 },
    })

    expect(virtualizer.getTotalSize()).toBe(120)
    virtualizer.resizeItem(0, 100)
    // v2 setters land on the next microtask flush; force it so the read below
    // observes the resize synchronously.
    flush()
    expect(virtualizer.getTotalSize()).toBe(160)

    setCount(3)
    flush()

    expect(virtualizer.itemSizeCache.get(0)).toBe(100)
    expect(virtualizer.getTotalSize()).toBe(220)
    dispose()
  })
})
