import { agentHue, agentName, agentProgress, type AgentProgress } from "../lib/derive";
import { baseName, duration, stripAnsi } from "../lib/format";
import { setWatch, useDetails } from "../lib/store";
import { settings } from "../lib/settings";
import type { Detail, Head, Step } from "../lib/types";
import { FileIcon } from "./FileIcon";

/**
 * The team at a glance, as a wall of monitors: one tile per agent at work (and Claude), each
 * showing what its screen shows at the cursor: the lines of the file it's on, the command it ran
 * and the end of its output, or what it last said. Click a tile to follow that agent.
 */

interface Member {
  n: number;
  p: AgentProgress;
}

const TILE_LINES = 12;

export function TeamGrid({ head, steps, cursor, watch }: { head: Head | null; steps: Step[]; cursor: number; watch: number }) {
  // Claude, then every agent started by the cursor: working ones first.
  let mainLast: Step | null = null;
  let mainCount = 0;
  let mainLater = 0;
  for (const s of steps) {
    if (s.agent !== 0) continue;
    if (s.i <= cursor) {
      mainCount++;
      mainLast = s;
    } else mainLater++;
  }
  const live = !!head && head.status !== "ended";
  const main: Member = {
    n: 0,
    p: { started: true, count: mainCount, last: mainLast, later: mainLater, state: mainLater > 0 || live ? "running" : "done" },
  };
  const agents: Member[] = (head?.agents ?? [])
    .map((_, k) => ({ n: k + 1, p: agentProgress(steps, cursor, head, k + 1) }))
    .filter((m) => m.p.started)
    .sort((a, b) => Number(!working(a.p)) - Number(!working(b.p)) || a.n - b.n);
  const members = [main, ...agents];
  const details = useDetails(members.map((m) => m.p.last).filter((s): s is Step => !!s));
  const detailOf = new Map<number, Detail | null | undefined>();
  members.filter((m) => m.p.last).forEach((m, k) => detailOf.set(m.n, details[k]));
  const now = steps[Math.min(cursor, steps.length - 1)]?.ts ?? 0;
  const busy = agents.filter((a) => working(a.p)).length;

  return (
    <div className="team">
      <div className="team-head">
        <b>Team</b>
        <span className="dim">
          Claude and {agents.length} agent{agents.length === 1 ? "" : "s"} · {busy} working
        </span>
        <span className="team-fill" />
        <span className="dim">Click a screen to follow it</span>
      </div>
      <div className="team-grid">
        {members.map((m) => (
          <Tile key={m.n} m={m} head={head} d={detailOf.get(m.n)} now={now} watched={m.n === watch} />
        ))}
      </div>
    </div>
  );
}

function working(p: AgentProgress) {
  return p.state === "running" || p.state === "starting";
}

function Tile({ m, head, d, now, watched }: { m: Member; head: Head | null; d: Detail | null | undefined; now: number; watched: boolean }) {
  const s = m.p.last;
  const name = m.n === 0 ? "Claude" : agentName(head, m.n);
  const kind = m.n === 0 ? "main session" : (head?.agents[m.n - 1]?.kind ?? "agent");
  return (
    <button
      className={`tile${working(m.p) ? " working" : ""}${watched ? " watched" : ""}`}
      style={{ ["--hue" as string]: agentHue(m.n) }}
      onClick={() => {
        setWatch(m.n);
        settings.set({ showTeam: false });
      }}
      title={`Follow ${name}`}
    >
      <div className="tile-head">
        <span className="presence-dot small">{m.n === 0 ? "C" : m.n}</span>
        <span className="tile-name ellipsis">{name}</span>
        {working(m.p) ? <span className="spinner" /> : <span className="tile-state">{m.p.state}</span>}
      </div>
      <div className="tile-sub">
        {kind} · {m.p.count} step{m.p.count === 1 ? "" : "s"}
        {s && now - s.ts > 1000 ? ` · ${duration(now - s.ts)} ago` : ""}
      </div>
      <Screen s={s} d={d} />
    </button>
  );
}

/** What the member's screen shows: a file's lines, a command and its output, or its words. */
function Screen({ s, d }: { s: Step | null; d: Detail | null | undefined }) {
  if (!s) return <div className="tile-screen empty">Starting…</div>;
  if (s.kind === "say" || s.kind === "prompt") {
    return <div className="tile-screen words">{(s.text ?? s.label).slice(0, 600)}</div>;
  }
  if (s.kind !== "tool") return <div className="tile-screen empty">{s.label}</div>;
  const file = fileLines(s, d);
  if (file) {
    return (
      <div className="tile-screen code">
        <div className="tile-file">
          <FileIcon name={baseName(file.path)} />
          <span className="ellipsis">{baseName(file.path)}</span>
          <span className="tile-verb">{file.verb}</span>
        </div>
        <pre>
          {file.lines.map((l, k) => (
            <div key={k}>
              <span className="tile-ln">{file.start + k}</span>
              {l}
            </div>
          ))}
        </pre>
      </div>
    );
  }
  if (s.cat === "shell" || s.cat === "git") {
    const out = stripAnsi((d?.stdout || d?.stderr || d?.output || "").replace(/\r\n/g, "\n")).replace(/\n+$/, "");
    const tail = out ? out.split("\n").slice(-TILE_LINES + 2) : [];
    return (
      <div className="tile-screen term">
        <pre>
          <div className="tile-cmd">$ {(d?.command ?? s.label).split("\n")[0]}</div>
          {s.state === "run" ? <div className="dim">running…</div> : tail.map((l, k) => <div key={k}>{l}</div>)}
        </pre>
      </div>
    );
  }
  return (
    <div className="tile-screen words">
      <b>{s.tool}</b> {s.label}
    </div>
  );
}

/** The lines of the file a step is on, around where it read or changed it. */
function fileLines(s: Step, d: Detail | null | undefined): { path: string; start: number; lines: string[]; verb: string } | null {
  if (!d) return null;
  const cut = (text: string, from: number, start: number) => {
    const all = text.replace(/\r\n/g, "\n").split("\n");
    const at = Math.max(0, from - start);
    return { start: start + at, lines: all.slice(at, at + TILE_LINES) };
  };
  if (d.kind === "read" && d.content != null && d.path) {
    return { path: d.path, verb: "reading", ...cut(d.content, d.startLine ?? 1, d.startLine ?? 1) };
  }
  if (d.kind === "edit" && d.path && d.after != null) {
    const a = (d.before ?? "").replace(/\r\n/g, "\n");
    const b = d.after.replace(/\r\n/g, "\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const start = d.startLine ?? 1;
    const changed = start + (b.slice(0, i).match(/\n/g)?.length ?? 0);
    return { path: d.path, verb: s.cat === "write" ? "writing" : "editing", ...cut(b, Math.max(start, changed - 2), start) };
  }
  if (d.kind === "shell") {
    const f = d.files?.find((x) => x.op === "read" && x.exact);
    if (f && s.state === "ok") {
      const out = d.stdout ?? d.output ?? "";
      return { path: f.path, verb: "reading", ...cut(out, f.line ?? 1, f.line ?? 1) };
    }
    const w = d.files?.find((x) => x.op === "write" && x.content != null);
    if (w?.content != null) return { path: w.path, verb: "writing", ...cut(w.content, 1, 1) };
  }
  return null;
}
