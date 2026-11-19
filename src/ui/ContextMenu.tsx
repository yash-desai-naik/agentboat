import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getSession } from "../lib/store";
import { openInClaudeCode } from "../lib/attention";
import { copyText, fullPath, openInEditor, relativePath, useEditors } from "../lib/editors";

/**
 * Ccboat's right-click menu, in place of the browser's. Anything that shows a file or folder
 * carries it as `data-path` (with `data-line` for a line in it, `data-session` and `data-cwd` for a
 * session), and a right-click on it offers to copy the path and to open it in Claude Code or an
 * installed editor. Selected text can be copied anywhere.
 */
interface Target {
  path: string;
  line: number | null;
  /** The folder relative paths are resolved in (the session's, unless the element says). */
  cwd: string | null;
  session: string | null;
}

interface Menu {
  x: number;
  y: number;
  target: Target | null;
  selection: string;
}

export function ContextMenu() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [note, setNote] = useState<{ x: number; y: number; text: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const editors = useEditors();

  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest("input, textarea, [contenteditable='true']")) return;
      const el = t.closest<HTMLElement>("[data-path]");
      const selection = window.getSelection()?.toString() ?? "";
      if (!el && !selection.trim()) {
        setMenu(null);
        return;
      }
      e.preventDefault();
      const d = el?.dataset;
      setMenu({
        x: e.clientX,
        y: e.clientY,
        selection,
        target: d?.path
          ? {
              path: d.path,
              line: d.line ? Number(d.line) || null : null,
              cwd: d.cwd ?? getSession().head?.meta.cwd ?? null,
              session: d.session ?? null,
            }
          : null,
      });
    };
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close();
    window.addEventListener("contextmenu", onMenu);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("contextmenu", onMenu);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, []);

  // Kept inside the window.
  useLayoutEffect(() => {
    const b = box.current;
    if (!b || !menu) return;
    b.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - b.offsetWidth - 4))}px`;
    b.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - b.offsetHeight - 4))}px`;
  }, [menu]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 1400);
    return () => window.clearTimeout(t);
  }, [note]);

  if (!menu && !note) return null;
  if (!menu) return <div className="ctx-note" style={{ left: note!.x, top: note!.y }}>{note!.text}</div>;

  const { target, selection } = menu;
  const full = target ? fullPath(target.path, target.cwd) : null;
  const rel = target ? relativePath(target.path, target.cwd) : null;
  const root = target?.session ? null : target?.cwd ?? null;
  const done = (text: string) => {
    setNote({ x: menu.x + 8, y: menu.y + 8, text });
    setMenu(null);
  };
  const act = (f: () => Promise<unknown>, ok: string | null) => () => {
    setMenu(null);
    void f()
      .then(() => ok && done(ok))
      .catch((e) => setNote({ x: menu.x + 8, y: menu.y + 8, text: String(e) }));
  };

  return (
    <div ref={box} className="ctx-menu" role="menu" onContextMenu={(e) => e.preventDefault()}>
      {selection.trim() && (
        <button role="menuitem" onClick={act(() => copyText(selection), "Copied")}>
          Copy
        </button>
      )}
      {target && full && (
        <>
          {selection.trim() && <div className="app-menu-sep" />}
          {target.session && (
            <button role="menuitem" onClick={act(() => openInClaudeCode(target.session!, full), null)}>
              Open in Claude Code
            </button>
          )}
          {editors.map((ed) => (
            <button key={ed.id} role="menuitem" onClick={act(() => openInEditor(ed.id, full, target.line, root), null)}>
              Open in {ed.name}
              {target.line ? <span className="ctx-dim"> at line {target.line}</span> : null}
            </button>
          ))}
          {(target.session || editors.length > 0) && <div className="app-menu-sep" />}
          <button role="menuitem" onClick={act(() => copyText(full), "Path copied")}>
            Copy path
          </button>
          {rel && (
            <button role="menuitem" onClick={act(() => copyText(rel), "Relative path copied")}>
              Copy relative path
            </button>
          )}
          {target.line && (
            <button role="menuitem" onClick={act(() => copyText(`${rel ?? full}:${target.line}`), "Copied with line")}>
              Copy path with line
            </button>
          )}
        </>
      )}
    </div>
  );
}
