import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
} from '@tanstack/virtual-core'

import {
  createEffect,
  createSignal,
  createStore,
  merge,
  onSettled,
  reconcile,
} from 'solid-js'
import type { PartialKeys, VirtualizerOptions } from '@tanstack/virtual-core'

export * from '@tanstack/virtual-core'

function createVirtualizerBase<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(
  options: VirtualizerOptions<TScrollElement, TItemElement>,
): Virtualizer<TScrollElement, TItemElement> {
  const resolvedOptions: VirtualizerOptions<TScrollElement, TItemElement> =
    merge(options)

  const instance = new Virtualizer<TScrollElement, TItemElement>(
    resolvedOptions,
  )

  const [virtualItems, setVirtualItems] = createStore(
    instance.getVirtualItems(),
  )
  const [totalSize, setTotalSize] = createSignal(instance.getTotalSize(), {
    // virtual-core drives these bridge signals from its imperative API
    // (resizeItem, measure, scroll handlers), which consumers may call from
    // an owned scope. The write is the adapter's own internal notify bridge,
    // not app state escaping a computation, so opt in to owned writes.
    ownedWrite: true,
  })

  const handler = {
    get(
      target: Virtualizer<TScrollElement, TItemElement>,
      prop: keyof Virtualizer<TScrollElement, TItemElement>,
    ) {
      switch (prop) {
        case 'getVirtualItems':
          return () => virtualItems
        case 'getTotalSize':
          return () => totalSize()
        default:
          return Reflect.get(target, prop)
      }
    },
  }

  const virtualizer = new Proxy(instance, handler)
  virtualizer.setOptions(resolvedOptions)

  onSettled(() => {
    const cleanup = virtualizer._didMount()
    virtualizer._willUpdate()
    return cleanup
  })

  createEffect(
    () => {
      // Compute phase: (re)apply options, tracking every reactive getter
      // read inside `setOptions`. No store/signal writes happen here — those
      // are forbidden inside a reactive scope in v2. The `onChange` callback
      // installed below fires from event/observer context, where writes are
      // legal.
      virtualizer.setOptions(
        merge(resolvedOptions, options, {
          onChange: (
            instance: Virtualizer<TScrollElement, TItemElement>,
            sync: boolean,
          ) => {
            instance._willUpdate()
            setVirtualItems(reconcile(instance.getVirtualItems(), 'index'))
            setTotalSize(instance.getTotalSize())
            options.onChange?.(instance, sync)
          },
        }),
      )
    },
    () => {
      // Apply phase: run the layout update and push the results into the
      // store/signal. Writes are permitted here.
      virtualizer._willUpdate()
      setVirtualItems(reconcile(instance.getVirtualItems(), 'index'))
      setTotalSize(instance.getTotalSize())
    },
  )

  return virtualizer
}

export function createVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: PartialKeys<
    VirtualizerOptions<TScrollElement, TItemElement>,
    'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
  >,
): Virtualizer<TScrollElement, TItemElement> {
  return createVirtualizerBase<TScrollElement, TItemElement>(
    merge(
      {
        observeElementRect: observeElementRect,
        observeElementOffset: observeElementOffset,
        scrollToFn: elementScroll,
      },
      options,
    ),
  )
}

export function createWindowVirtualizer<TItemElement extends Element>(
  options: PartialKeys<
    VirtualizerOptions<Window, TItemElement>,
    | 'getScrollElement'
    | 'observeElementRect'
    | 'observeElementOffset'
    | 'scrollToFn'
  >,
): Virtualizer<Window, TItemElement> {
  return createVirtualizerBase<Window, TItemElement>(
    merge(
      {
        getScrollElement: () =>
          typeof document !== 'undefined' ? window : null,
        observeElementRect: observeWindowRect,
        observeElementOffset: observeWindowOffset,
        scrollToFn: windowScroll,
        initialOffset: () =>
          typeof document !== 'undefined' ? window.scrollY : 0,
      },
      options,
    ),
  )
}
