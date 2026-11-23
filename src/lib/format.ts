/** "4m 12s", "1h 03m", "12s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** 14:03:22 local. */
export function clock(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "Mon 17 Nov, 14:03". */
export function dateTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** The last part of a path. */
export function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return i >= 0 ? t.slice(i + 1) : t;
}

/** Separators unified and, on Windows-style paths, case folded: the key a file is known by. */
export function pathKey(p: string): string {
  const s = p.replace(/\\/g, "/");
  return /^[a-z]:\//i.test(s) || s.startsWith("//") ? s.toLowerCase() : s;
}

/** `p` relative to `root` when inside it (with forward slashes), else null. */
export function relativeTo(p: string, root: string | null): string | null {
  if (!root) return null;
  const a = pathKey(p);
  const r = pathKey(root).replace(/\/+$/, "");
  if (a === r) return "";
  if (!a.startsWith(r + "/")) return null;
  return p.replace(/\\/g, "/").slice(r.length + 1);
}

/** Drops ANSI colour and cursor codes from terminal output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** `mcp__clickup__clickup_get_task` → `clickup: get_task`. */
export function shortTool(name: string | null): string {
  if (!name) return "";
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  if (i < 0) return rest;
  let server = rest.slice(0, i);
  let tool = rest.slice(i + 2);
  if (server.startsWith("claude_ai_")) server = server.slice(10);
  if (tool.startsWith(server + "_")) tool = tool.slice(server.length + 1);
  return `${server}: ${tool}`;
}

/** `claude-fable-5-2` → `Fable 5.2`, `claude-opus-4-8-20260101` → `Opus 4.8`, `claude-opus-5-5[1m]` → `Opus 5.5 (1M)`, `opus` → `Opus`. */
export function modelName(id: string | null): string {
  if (!id) return "";
  const big = /\[1m\]$/i.test(id) ? " (1M)" : "";
  const parts = id.replace(/\[1m\]$/i, "").replace(/^claude-/, "").split("-").filter((p) => !/^\d{8}$/.test(p));
  const [family, ...version] = parts;
  if (!family || version.some((v) => !/^\d+$/.test(v))) return id;
  return [family[0].toUpperCase() + family.slice(1), version.join(".")].filter(Boolean).join(" ") + big;
}
