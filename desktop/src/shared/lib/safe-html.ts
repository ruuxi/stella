const BLOCKED_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "srcdoc",
  "action",
  "formaction",
  "xlink:href",
]);

const hasUnsafeProtocol = (value: string) => {
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f\s]+/g, "")
    .toLowerCase();
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:text/html")
  );
};

export const sanitizeHtmlFragment = (html: string): string => {
  if (!html) {
    return "";
  }

  if (typeof document === "undefined") {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (BLOCKED_TAGS.has(tagName)) {
      element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value;

      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (URL_ATTRS.has(attributeName) && hasUnsafeProtocol(attributeValue)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        attributeName === "style" &&
        /expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i.test(attributeValue)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return template.innerHTML;
};
