import morphdom from 'morphdom'

type ApplyMorphdomHtmlOptions = {
  onNodeAdded?: (node: Node) => Node | void
}

export const applyMorphdomHtml = (
  container: HTMLElement,
  className: string,
  html: string,
  options?: ApplyMorphdomHtmlOptions,
) => {
  const target = document.createElement('div')
  target.className = className
  target.innerHTML = html

  morphdom(container, target, {
    onBeforeElUpdated(fromEl, toEl) {
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
    onNodeAdded: options?.onNodeAdded,
  })
}
