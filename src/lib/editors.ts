import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./tauri";
import { relativeTo } from "./format";

/** The editors installed here (src-tauri/src/editors.rs): VS Code, Zed. Looked up once. */
export interface Editor {
  id: "vscode" | "zed";
  name: string;
}

let editors: Editor[] | null = null;
let loading: Promise<Editor[]> | null = null;

function load(): Promise<Editor[]> {
  if (editors) return Promise.resolve(editors);
  if (!IN_TAURI) return Promise.resolve([]);
  loading ??= invoke<Editor[]>("editors")
    .catch(() => [])
    .then((e) => (editors = e));
  return loading;
}

export function useEditors(): Editor[] {
  const [e, setE] = useState<Editor[]>(editors ?? []);
  useEffect(() => {
    let live = true;
    void load().then((x) => live && setE(x));
    return () => {
      live = false;
    };
  }, []);
  return e;
}

/** A folder, or a file at a line; a file opens within the session's folder when it's inside it. */
export const openInEditor = (editor: Editor["id"], path: string, line: number | null, root: string | null) =>
  invoke<void>("open_in_editor", { editor, path, line, root });

const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");

/** An absolute path in the system's own form: relative ones resolved against `cwd`, and on
 *  Windows with backslashes throughout. */
export function fullPath(p: string, cwd: string | null): string {
  let full = p;
  if (!isAbsolute(p) && cwd) full = `${cwd.replace(/[\\/]+$/, "")}/${p.replace(/^\.[\\/]/, "")}`;
  return /^[A-Za-z]:/.test(full) || full.startsWith("\\\\") ? full.replace(/\//g, "\\") : full;
}

/** The path relative to the session's folder (forward slashes), when it's inside it. */
export function relativePath(p: string, cwd: string | null): string | null {
  const r = relativeTo(fullPath(p, cwd), cwd);
  return r ? r : null;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older WebViews without the async clipboard: the selection way.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
