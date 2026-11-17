import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";

// Links are shown, never followed (the app is read-only and opens nothing); images aren't loaded.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    if (href) node.setAttribute("title", href);
    node.removeAttribute("href");
    node.removeAttribute("target");
  }
  if (node.tagName === "IMG") {
    node.removeAttribute("src");
    node.removeAttribute("srcset");
  }
});

const FORBID_TAGS = ["style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base", "script"];

const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string, {
    FORBID_TAGS,
    FORBID_ATTR: ["style"],
  });
  if (cache.size > 800) cache.clear();
  cache.set(text, html);
  return html;
}

/** Markdown as safe HTML (Claude's replies, tool results). */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
