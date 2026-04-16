import morphdom from 'morphdom'

type ApplyMorphdomHtmlOptions = {
  onNodeAdded?: (node: Node) => Node | void
  executeScripts?: boolean
}

type ExecutableScriptElement = HTMLScriptElement & {
  __stellaScriptSignature?: string
}

const getScriptSignature = (script: HTMLScriptElement) =>
  JSON.stringify({
    attributes: Array.from(script.attributes).map(({ name, value }) => [name, value]),
    textContent: script.textContent ?? '',
  })

const cloneExecutableScript = (script: HTMLScriptElement) => {
  const replacement = document.createElement('script') as ExecutableScriptElement
  for (const { name, value } of Array.from(script.attributes)) {
    replacement.setAttribute(name, value)
  }
  replacement.textContent = script.textContent
  return replacement
}

const executePendingScripts = (container: HTMLElement) => {
  const scripts = Array.from(
    container.querySelectorAll('script'),
  ) as ExecutableScriptElement[]

  for (const script of scripts) {
    const signature = getScriptSignature(script)
    if (script.__stellaScriptSignature === signature) continue

    const replacement = cloneExecutableScript(script)
    replacement.__stellaScriptSignature = signature
    script.replaceWith(replacement)
  }
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

  if (options?.executeScripts) {
    executePendingScripts(container)
  }
}
