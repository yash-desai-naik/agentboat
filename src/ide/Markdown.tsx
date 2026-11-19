import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";

/** Web and mail links: the only ones kept (copied with the text, opened in the browser). */
export function safeLink(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

// Links keep their address, so copying text copies working links; anything that isn't a web or
// mail link loses it. A click never navigates AgentBoat's own window: it opens the link in the
// default browser (see `openLinksInBrowser`). Images aren't loaded.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = safeLink(node.getAttribute("href"));
    if (href) {
      node.setAttribute("href", href);
      node.setAttribute("title", href);
      node.setAttribute("rel", "noopener noreferrer");
    } else node.removeAttribute("href");
    node.removeAttribute("target");
  }
  if (node.tagName === "IMG") {
    node.removeAttribute("src");
    node.removeAttribute("srcset");
  }
});

/**
 * Every link click in the page opens the link in the default browser instead of navigating the
 * app's window (which would leave AgentBoat). Rust checks the address again (web and mail only).
 */
export function openLinksInBrowser() {
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const href = safeLink(a.getAttribute("href"));
      if (href) void invoke("open_url", { url: href }).catch(() => {});
    },
    true,
  );
}

const FORBID_TAGS =["style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base", "script"];

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
