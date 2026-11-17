import { memo, useMemo, useState } from "react";
import { Markdown } from "./Markdown";

/**
 * Any tool's response, shown by the shape of its data, never by which tool or server sent it:
 *
 * - an object that names something (`name`, `title`, `subject`…): a record card with its title,
 *   status-like fields as badges, people as chips, the description rendered, plain fields in a
 *   grid and nested parts expandable;
 * - a list of objects (or an object wrapping one, like `{ tasks: [...], total }`): a table of
 *   the most telling columns, each row expandable;
 * - text: markdown when it looks like markdown, else as is;
 * - anything else: a JSON tree.
 */

export type Parsed = { kind: "json"; value: unknown } | { kind: "text"; text: string };

/** A response's text as data when it's JSON (also JSON after a short lead-in like "Result:"). */
export function parseOutput(text: string): Parsed {
  const t = text.trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  if (t.startsWith("{") || t.startsWith("[")) {
    const v = tryParse(t);
    if (v !== undefined) return { kind: "json", value: v };
  }
  // "Created task: {...}" — a short lead-in, then JSON to the end.
  const m = /^[^{[\n]{1,80}?[:\n]\s*([{[][\s\S]*)$/.exec(t);
  if (m) {
    const v = tryParse(m[1]);
    if (v !== undefined && typeof v === "object") return { kind: "json", value: v };
  }
  return { kind: "text", text };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrim = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

const TITLE_KEYS = ["name", "title", "subject", "summary", "displayName", "display_name", "label", "filename", "fileName", "path", "full_name"];
const ID_KEYS = ["custom_id", "key", "number", "id", "identifier", "slug"];
const BADGE_RE = /^(status|state|priority|type|kind|severity|level|stage|visibility|role|conclusion|result)$/i;
const TEXT_RE = /^(description|text_content|markdown_description|body|content|text|message|details|notes)$/i;
const URL_RE = /(^|_)(url|link|href|html_url|web_url)$/i;
const TIME_RE = /(date|time|_at$|At$|^created|^updated|^due|^start|^end|^closed|^modified|timestamp)/i;
const PEOPLE_RE = /^(assignees?|owners?|creator|author|user|users|members|watchers|reviewers?|requested_reviewers|participants|followers)$/i;

/** A field's value in a few words. */
function short(key: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" || (typeof v === "string" && /^\d{10,13}$/.test(v))) {
    const n = Number(v);
    if (TIME_RE.test(key) && n > 9e8) {
      const d = new Date(n > 1e11 ? n : n * 1000);
      if (!isNaN(d.getTime())) return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    }
    return String(v);
  }
  if (typeof v === "string") {
    if (TIME_RE.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    }
    return v;
  }
  if (Array.isArray(v)) {
    if (v.every(isPrim)) return v.join(", ");
    const names = v.map(nameOf).filter(Boolean);
    return names.length === v.length && names.length <= 4 ? names.join(", ") : `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  if (isObj(v)) return nameOf(v) ?? `{${Object.keys(v).length}}`;
  return String(v);
}

/** What an object is called: a status's status, a person's name, a thing's title. */
function nameOf(v: unknown): string | null {
  if (isPrim(v)) return v === null ? null : String(v);
  if (!isObj(v)) return null;
  for (const k of ["status", "name", "title", "username", "login", "display_name", "displayName", "email", "label", "value"]) {
    if (typeof v[k] === "string" && v[k]) return v[k] as string;
  }
  return null;
}

function titleKey(o: Obj): string | null {
  return TITLE_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim()) ?? null;
}

/** A stable colour for a badge's text (the same status always looks the same). */
function hue(s: string): number {
  const t = s.toLowerCase();
  // Not started yet (or just open): neutral, neither good nor bad.
  if (/(not started|to ?do|backlog|\bnew\b|\bopen\b|unassigned|^none$)/.test(t)) return -1;
  if (/(done|complete|closed|merged|success|pass|resolved|active|ok)/.test(t)) return 145;
  if (/(fail|error|block|urgent|critical|high|reject|cancel)/.test(t)) return 8;
  if (/(progress|review|pending|wait|draft|medium|running|queued)/.test(t)) return 40;
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// ---------- the entry point ----------

export const DataView = memo(function DataView({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.filter(isObj).length >= value.length * 0.8) return <DataTable rows={value.filter(isObj)} />;
    if (value.every(isPrim)) return <PrimList items={value} />;
    return <JsonTree value={value} open={2} />;
  }
  if (isObj(value)) {
    // A wrapper around a list: `{ tasks: [...], total: 12 }`.
    const entries = Object.entries(value);
    const lists = entries.filter(([, v]) => Array.isArray(v) && v.length > 0 && v.filter(isObj).length >= v.length * 0.8);
    const rest = entries.filter(([, v]) => isPrim(v));
    if (lists.length === 1 && !titleKey(value) && lists.length + rest.length === entries.length) {
      const [key, rows] = lists[0];
      return (
        <div className="dv">
          {rest.length > 0 && (
            <div className="dv-meta">
              {rest.map(([k, v]) => (
                <span key={k}>
                  <b>{k}</b> {short(k, v)}
                </span>
              ))}
            </div>
          )}
          <div className="dv-section-title">
            {key} <span className="dv-count">{(rows as unknown[]).length}</span>
          </div>
          <DataTable rows={(rows as unknown[]).filter(isObj)} />
        </div>
      );
    }
    if (titleKey(value)) return <RecordCard obj={value} />;
    return <JsonTree value={value} open={2} />;
  }
  return <pre className="dv-pre">{String(value)}</pre>;
});

/** Text: rendered as markdown when it looks like it, else as written. */
export function TextView({ text }: { text: string }) {
  const md = /(^|\n)(#{1,4} |[-*] |\d+\. |> |```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text);
  return md ? <Markdown text={text} className="dv-md" /> : <pre className="dv-pre">{text}</pre>;
}

// ---------- record ----------

function RecordCard({ obj }: { obj: Obj }) {
  const tk = titleKey(obj)!;
  const idKey = ID_KEYS.find((k) => k !== tk && isPrim(obj[k]) && obj[k] !== null && obj[k] !== "");
  const badges: [string, string][] = [];
  const people: [string, string[]][] = [];
  const urls: [string, string][] = [];
  const texts: [string, string][] = [];
  const fields: [string, unknown][] = [];
  const nested: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === tk || k === idKey || v === null || v === undefined || v === "") continue;
    if (BADGE_RE.test(k) && (isPrim(v) || nameOf(v))) badges.push([k, nameOf(v) ?? String(v)]);
    else if (PEOPLE_RE.test(k) && (Array.isArray(v) || isObj(v))) {
      const list = (Array.isArray(v) ? v : [v]).map(nameOf).filter((x): x is string => !!x);
      if (list.length) people.push([k, list]);
      else nested.push([k, v]);
    } else if (URL_RE.test(k) && typeof v === "string") urls.push([k, v]);
    else if (TEXT_RE.test(k) && typeof v === "string" && v.length > 60) texts.push([k, v]);
    else if (isPrim(v) && String(v).length <= 160) fields.push([k, v]);
    else if (typeof v === "string") texts.push([k, v]);
    else if (Array.isArray(v) && v.length === 0) fields.push([k, "—"]);
    else nested.push([k, v]);
  }
  return (
    <div className="dv-card">
      <div className="dv-card-head">
        <div className="dv-card-title">{obj[tk] as string}</div>
        {idKey && <span className="dv-id">{String(obj[idKey])}</span>}
      </div>
      {(badges.length > 0 || people.length > 0) && (
        <div className="dv-badges">
          {badges.map(([k, v]) => (
            <span key={k} className={`dv-badge${hue(v) < 0 ? " neutral" : ""}`} style={{ ["--h" as string]: hue(v) }} title={k}>
              {v}
            </span>
          ))}
          {people.map(([k, list]) => (
            <span key={k} className="dv-people" title={k}>
              {list.slice(0, 6).map((p) => (
                <span key={p} className="dv-person">
                  <span className="dv-avatar">{p.slice(0, 1).toUpperCase()}</span>
                  {p}
                </span>
              ))}
              {list.length > 6 && <span className="dv-more">+{list.length - 6}</span>}
            </span>
          ))}
        </div>
      )}
      {urls.map(([k, u]) => (
        <div key={k} className="dv-url mono" title={k}>
          {u}
        </div>
      ))}
      {fields.length > 0 && (
        <div className="dv-grid">
          {fields.map(([k, v]) => (
            <div key={k} className="dv-field">
              <span className="dv-k">{k}</span>
              <span className="dv-v">{short(k, v)}</span>
            </div>
          ))}
        </div>
      )}
      {texts.map(([k, t]) => (
        <Collapsible key={k} title={k} open={texts.length === 1}>
          <TextView text={t.length > 20000 ? t.slice(0, 20000) + "\n…" : t} />
        </Collapsible>
      ))}
      {nested.map(([k, v]) => (
        <Collapsible key={k} title={k} badge={Array.isArray(v) ? String(v.length) : undefined}>
          <DataView value={v} />
        </Collapsible>
      ))}
    </div>
  );
}

function Collapsible({ title, badge, open, children }: { title: string; badge?: string; open?: boolean; children: React.ReactNode }) {
  const [o, setO] = useState(!!open);
  return (
    <div className="dv-collapsible">
      <button className="dv-section-title btn" onClick={() => setO(!o)}>
        <span className="dv-caret">{o ? "▾" : "▸"}</span> {title} {badge && <span className="dv-count">{badge}</span>}
      </button>
      {o && <div className="dv-collapsible-body">{children}</div>}
    </div>
  );
}

// ---------- table ----------

const PREFERRED = ["name", "title", "subject", "custom_id", "key", "number", "id", "status", "state", "priority", "type", "assignees", "assignee", "due_date", "date", "updated_at", "date_updated", "created_at", "date_created", "url"];

function columnsOf(rows: Obj[]): string[] {
  const freq = new Map<string, number>();
  for (const r of rows.slice(0, 60))
    for (const [k, v] of Object.entries(r)) {
      if (isPrim(v) || nameOf(v) || (Array.isArray(v) && v.length <= 6)) freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  const keys = [...freq.keys()];
  const pref = PREFERRED.filter((k) => freq.has(k));
  const rest = keys.filter((k) => !pref.includes(k) && !TEXT_RE.test(k)).sort((a, b) => freq.get(b)! - freq.get(a)!);
  // A title column makes a plain id column redundant beside it.
  let cols = [...pref, ...rest];
  if (cols.some((c) => TITLE_KEYS.includes(c))) cols = cols.filter((c) => c !== "id" || cols.indexOf("id") < 2);
  return cols.slice(0, 6);
}

function DataTable({ rows }: { rows: Obj[] }) {
  const cols = useMemo(() => columnsOf(rows), [rows]);
  const [open, setOpen] = useState<number | null>(null);
  const shown = rows.slice(0, 200);
  return (
    <div className="dv-table-wrap">
      <table className="dv-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, k) => (
            <TableRow key={k} row={r} cols={cols} open={open === k} onToggle={() => setOpen(open === k ? null : k)} />
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <div className="dv-more-rows">{rows.length - shown.length} more rows</div>}
    </div>
  );
}

function TableRow({ row, cols, open, onToggle }: { row: Obj; cols: string[]; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={open ? "open" : ""} onClick={onToggle}>
        {cols.map((c) => {
          const v = row[c];
          const badge = BADGE_RE.test(c) && v != null ? (nameOf(v) ?? String(v)) : null;
          return (
            <td key={c} title={typeof v === "string" ? v : undefined}>
              {badge ? (
                <span className={`dv-badge${hue(badge) < 0 ? " neutral" : ""}`} style={{ ["--h" as string]: hue(badge) }}>
                  {badge}
                </span>
              ) : (
                short(c, v)
              )}
            </td>
          );
        })}
      </tr>
      {open && (
        <tr className="dv-row-detail">
          <td colSpan={cols.length}>
            <DataView value={row} />
          </td>
        </tr>
      )}
    </>
  );
}

function PrimList({ items }: { items: unknown[] }) {
  return (
    <ul className="dv-list">
      {items.slice(0, 500).map((v, k) => (
        <li key={k}>{String(v)}</li>
      ))}
    </ul>
  );
}

// ---------- JSON tree ----------

export function JsonTree({ value, open = 1, name }: { value: unknown; open?: number; name?: string }) {
  return (
    <div className="jt">
      <JsonNode k={name} v={value} depth={0} open={open} />
    </div>
  );
}

function JsonNode({ k, v, depth, open }: { k?: string; v: unknown; depth: number; open: number }) {
  const [o, setO] = useState(depth < open);
  const key = k !== undefined ? <span className="jt-k">{k}: </span> : null;
  if (!isObj(v) && !Array.isArray(v)) {
    const cls = typeof v === "string" ? "jt-s" : typeof v === "number" ? "jt-n" : "jt-l";
    const text = typeof v === "string" ? JSON.stringify(v.length > 2000 ? v.slice(0, 2000) + "…" : v) : String(v);
    return (
      <div className="jt-row" style={{ paddingLeft: depth * 14 }}>
        {key}
        <span className={cls}>{text}</span>
      </div>
    );
  }
  const entries: [string, unknown][] = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  const [l, r] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  return (
    <>
      <div className="jt-row jt-toggle" style={{ paddingLeft: depth * 14 }} onClick={() => setO(!o)}>
        <span className="jt-caret">{o ? "▾" : "▸"}</span>
        {key}
        <span className="jt-p">{o ? l : `${l} ${entries.length} ${Array.isArray(v) ? "items" : "keys"} ${r}`}</span>
      </div>
      {o &&
        entries.slice(0, 500).map(([ck, cv]) => <JsonNode key={ck} k={ck} v={cv} depth={depth + 1} open={open} />)}
      {o && entries.length > 500 && <div className="jt-row jt-p" style={{ paddingLeft: (depth + 1) * 14 }}>… {entries.length - 500} more</div>}
      {o && (
        <div className="jt-row jt-p" style={{ paddingLeft: depth * 14 }}>
          {r}
        </div>
      )}
    </>
  );
}
