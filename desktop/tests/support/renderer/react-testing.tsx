import {
  act,
  createElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  configure,
  fireEvent as domFireEvent,
  getQueriesForElement,
  prettyDOM,
  queries,
  screen,
  waitFor,
  within,
  type BoundFunctions,
  type Queries,
} from '@testing-library/dom'

type WrapperComponent = ComponentType<{ children?: ReactNode }>
type DebugTarget = HTMLElement | DocumentFragment

type RenderOptions = {
  container?: HTMLElement
  baseElement?: HTMLElement
  wrapper?: WrapperComponent
}

type RenderResult = BoundFunctions<typeof queries> & {
  asFragment: () => DocumentFragment
  baseElement: HTMLElement
  container: HTMLElement
  debug: (element?: DebugTarget) => void
  rerender: (ui: ReactElement) => void
  unmount: () => void
}

type RenderHookOptions<TProps> = {
  initialProps?: TProps
  wrapper?: WrapperComponent
}

type RenderHookResult<TResult, TProps> = {
  result: {
    readonly current: TResult
  }
  rerender: (props?: TProps) => void
  unmount: () => void
}

const mountedRoots = new Map<
  HTMLElement,
  { root: Root; removeAfterCleanup: boolean }
>()

const fireEvent = ((...args: Parameters<typeof domFireEvent>) =>
  domFireEvent(...args)) as typeof domFireEvent

Object.assign(fireEvent, domFireEvent)

const mouseEnter = fireEvent.mouseEnter
const mouseLeave = fireEvent.mouseLeave
fireEvent.mouseEnter = ((...args: Parameters<typeof mouseEnter>) => {
  mouseEnter(...args)
  return fireEvent.mouseOver(...args)
}) as typeof fireEvent.mouseEnter
fireEvent.mouseLeave = ((...args: Parameters<typeof mouseLeave>) => {
  mouseLeave(...args)
  return fireEvent.mouseOut(...args)
}) as typeof fireEvent.mouseLeave

const pointerEnter = fireEvent.pointerEnter
const pointerLeave = fireEvent.pointerLeave
fireEvent.pointerEnter = ((...args: Parameters<typeof pointerEnter>) => {
  pointerEnter(...args)
  return fireEvent.pointerOver(...args)
}) as typeof fireEvent.pointerEnter
fireEvent.pointerLeave = ((...args: Parameters<typeof pointerLeave>) => {
  pointerLeave(...args)
  return fireEvent.pointerOut(...args)
}) as typeof fireEvent.pointerLeave

const select = fireEvent.select
fireEvent.select = ((node: Element, init?: EventInit) => {
  select(node, init)
  ;(node as HTMLElement).focus()
  fireEvent.keyUp(node, init)
}) as typeof fireEvent.select

const blur = fireEvent.blur
const focus = fireEvent.focus
fireEvent.blur = ((...args: Parameters<typeof blur>) => {
  fireEvent.focusOut(...args)
  return blur(...args)
}) as typeof fireEvent.blur
fireEvent.focus = ((...args: Parameters<typeof focus>) => {
  fireEvent.focusIn(...args)
  return focus(...args)
}) as typeof fireEvent.focus

const getActEnvironment = () =>
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT

const setActEnvironment = (value: boolean) => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = value
}

configure({
  unstable_advanceTimersWrapper: (callback) => act(callback),
  eventWrapper: (callback) => {
    let result: unknown
    act(() => {
      result = callback()
    })
    return result
  },
  asyncWrapper: async (callback) => {
    const previousActEnvironment = getActEnvironment()
    setActEnvironment(false)

    try {
      const result = await callback()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      return result
    } finally {
      setActEnvironment(Boolean(previousActEnvironment))
    }
  },
})

const wrapUi = (ui: ReactElement, wrapper?: WrapperComponent) =>
  wrapper ? createElement(wrapper, null, ui) : ui

const toFragment = (container: HTMLElement) => {
  const fragment = document.createDocumentFragment()
  for (const child of Array.from(container.childNodes)) {
    fragment.appendChild(child.cloneNode(true))
  }
  return fragment
}

const attachContainer = (
  baseElement: HTMLElement,
  container?: HTMLElement,
) => {
  if (container) {
    if (!container.parentNode) {
      baseElement.appendChild(container)
    }
    return { container, removeAfterCleanup: false }
  }

  const nextContainer = document.createElement('div')
  baseElement.appendChild(nextContainer)
  return { container: nextContainer, removeAfterCleanup: true }
}

const unmountContainer = (container: HTMLElement, removeAfterCleanup: boolean) => {
  const mounted = mountedRoots.get(container)
  if (!mounted) {
    return
  }

  act(() => {
    mounted.root.unmount()
  })
  mountedRoots.delete(container)

  if (removeAfterCleanup && container.parentNode) {
    container.parentNode.removeChild(container)
  }
}

export function cleanup() {
  for (const [container, mounted] of Array.from(mountedRoots.entries())) {
    unmountContainer(container, mounted.removeAfterCleanup)
  }
}

export function render(
  ui: ReactElement,
  options: RenderOptions = {},
): RenderResult {
  const baseElement = options.baseElement ?? document.body
  const { container, removeAfterCleanup } = attachContainer(
    baseElement,
    options.container,
  )

  const root = createRoot(container)
  mountedRoots.set(container, { root, removeAfterCleanup })

  act(() => {
    root.render(wrapUi(ui, options.wrapper))
  })

  return {
    ...getQueriesForElement(baseElement),
    container,
    baseElement,
    debug: (element = baseElement) => {
      const target =
        element instanceof DocumentFragment
          ? (element.firstElementChild ?? baseElement)
          : element
      const output = prettyDOM(target)
      if (output) {
        console.log(output)
      }
    },
    asFragment: () => toFragment(container),
    rerender: (nextUi) => {
      act(() => {
        root.render(wrapUi(nextUi, options.wrapper))
      })
    },
    unmount: () => {
      unmountContainer(container, removeAfterCleanup)
    },
  }
}

export function renderHook<TResult, TProps = void>(
  callback: (props: TProps) => TResult,
  options: RenderHookOptions<TProps> = {},
): RenderHookResult<TResult, TProps> {
  let current = null as TResult
  let hookProps = options.initialProps as TProps

  function HookHost(props: { hookProps: TProps }) {
    current = callback(props.hookProps)
    return null
  }

  const rendered = render(<HookHost hookProps={hookProps} />, {
    wrapper: options.wrapper,
  })

  return {
    result: {
      get current() {
        return current
      },
    },
    rerender: (nextProps = hookProps) => {
      hookProps = nextProps
      rendered.rerender(<HookHost hookProps={hookProps} />)
    },
    unmount: rendered.unmount,
  }
}

export { act, fireEvent, queries, screen, waitFor, within }
export type { Queries }
