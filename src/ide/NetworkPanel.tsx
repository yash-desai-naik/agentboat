import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Ide } from "../lib/derive";
import { agentHue, agentName } from "../lib/derive";
import { bytes, clock, duration } from "../lib/format";
import { seek, useDetail } from "../lib/store";
import type { Detail, Head, Step } from "../lib/types";
import { DataView, JsonTree, parseOutput, TextView } from "./DataView";

/**
 * Every call to an MCP server, the web and Claude's other non-file tools, as a browser's DevTools
 * Network panel shows requests: one row per call (server, tool, status, time, size), and the
 * selected call's request and response. Generic: nothing here knows any particular server.
 */

/** `mcp__claude_ai_Claude_Docs__batch` → ["Claude_Docs", "batch"]; built-in tools → ["claude", name]. */
export function splitTool(name: string | null): [string, string] {
  if (!name) return ["claude", "tool"];
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    let server = i < 0 ? rest : rest.slice(0, i);
    let tool = i < 0 ? "" : rest.slice(i + 2);
    if (server.startsWith("claude_ai_")) server = server.slice(10);
    if (tool.startsWith(server + "_")) tool = tool.slice(server.length + 1);
    return [server, tool];
  }
  if (name === "WebFetch" || name === "WebSearch") return ["web", name];
  return ["claude", name];
}

/** A server's colour, from its name: the same server always looks the same. */
export function serverHue(server: string): number {
  if (server === "claude") return 25;
  if (server === "web") return 205;
  let h = 7;
  for (const ch of server.toLowerCase()) h = (h * 33 + ch.charCodeAt(0)) % 360;
  return h;
}

const ROWS = 400;

export function NetworkPanel({ ide, head, steps, switcher }: { ide: Ide; head: Head | null; steps: Step[]; switcher: React.ReactNode }) {
  const list = ide.network.slice(-ROWS).map((i) => steps[i]);
  const cur = ide.current;
  // The call shown: the current step if it's one, else the latest call before it.
  const selected = cur && ide.network.includes(cur.i) ? cur : list[list.length - 1];
  const [filter, setFilter] = useState("");
  const shown = filter ? list.filter((s) => (s.tool ?? "").toLowerCase().includes(filter.toLowerCase()) || s.label.toLowerCase().includes(filter.toLowerCase())) : list;
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current?.querySelector(".nw-row.selected");
    el?.scrollIntoView({ block: "nearest" });
  }, [selected?.i, list.length]);

  return (
    <section className="panel">
      <div className="panel-tabs">
        {switcher}
        <input className="nw-filter" placeholder="Filter calls" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
      </div>
      <div className="nw">
        <div className="nw-list" ref={box}>
          <div className="nw-head">
            <span>Call</span>
            <span>Status</span>
            <span className="r">Time</span>
            <span className="r">Size</span>
          </div>
          {shown.length === 0 && <p className="side-empty">MCP, web and other tool calls show here as Claude makes them.</p>}
          {shown.map((s) => {
            const [server, tool] = splitTool(s.tool);
            return (
              <div key={s.i} className={`nw-row ${s.state}${s.i === selected?.i ? " selected" : ""}`} onClick={() => seek(s.i)} title={`${clock(s.ts)} · ${s.label}`}>
                <span className="nw-call">
                  <span className="nw-server" style={{ ["--h" as string]: serverHue(server) }}>
                    {server}
                  </span>
                  <b>{tool}</b>
                  <span className="nw-arg">{s.label && s.label !== tool && !s.label.endsWith(`: ${tool}`) ? s.label : ""}</span>
                </span>
                <span className={`nw-status ${s.state}`}>{s.state === "run" ? <span className="spinner" /> : s.state === "ok" ? "OK" : "Failed"}</span>
                <span className="r mono">{s.end && s.end >= s.ts ? duration(s.end - s.ts) : ""}</span>
                <span className="r mono">{s.size != null ? bytes(s.size) : ""}</span>
              </div>
            );
          })}
        </div>
        <div className="nw-inspector">{selected ? <Inspector step={selected} head={head} /> : null}</div>
      </div>
    </section>
  );
}

function Inspector({ step, head }: { step: Step; head: Head | null }) {
  const d = useDetail(step);
  const [tab, setTab] = useState<"preview" | "response" | "request">("preview");
  const [server, tool] = splitTool(step.tool);
  return (
    <div className="nw-insp">
      <div className="nw-insp-head">
        <span className="nw-server" style={{ ["--h" as string]: serverHue(server) }}>
          {server}
        </span>
        <b className="ellipsis">{tool}</b>
        {step.agent > 0 && (
          <span className="agent-chip" style={{ ["--hue" as string]: agentHue(step.agent) }}>
            {agentName(head, step.agent)}
          </span>
        )}
        <span className="nw-fill" />
        <div className="seg">
          {(["preview", "response", "request"] as const).map((t) => (
            <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t === "preview" ? "Preview" : t === "response" ? "Response" : "Request"}
            </button>
          ))}
        </div>
      </div>
      <div className="nw-insp-body">
        {d === undefined ? null : !d ? (
          <p className="dim">No detail.</p>
        ) : tab === "request" ? (
          <RequestView d={d} />
        ) : step.state === "run" ? (
          <p className="dim">
            <span className="spinner" /> Waiting for the response…
          </p>
        ) : tab === "preview" ? (
          <Preview d={d} />
        ) : (
          <RawResponse d={d} />
        )}
      </div>
    </div>
  );
}

function RequestView({ d }: { d: Detail }) {
  const input = d.kind === "web" ? { url: d.url, query: d.query, prompt: d.prompt } : d.input;
  if (input == null) return <p className="dim">No arguments.</p>;
  if (typeof input === "string") return <pre className="dv-pre">{input}</pre>;
  return <JsonTree value={input} open={3} />;
}

function Preview({ d }: { d: Detail }) {
  const out = d.output ?? "";
  const parsed = useMemo(() => parseOutput(out), [out]);
  return (
    <>
      {d.image && <img className="out-img" src={`data:${d.image.mediaType};base64,${d.image.data}`} alt="" />}
      {d.error && !out && <pre className="dv-pre o-err">{d.error}</pre>}
      {out.trim() === "" && !d.image ? <p className="dim">Empty response.</p> : parsed.kind === "json" ? <DataView value={parsed.value} /> : <TextView text={out} />}
    </>
  );
}

function RawResponse({ d }: { d: Detail }) {
  const out = d.output ?? "";
  const pretty = useMemo(() => {
    const p = parseOutput(out);
    return p.kind === "json" ? JSON.stringify(p.value, null, 2) : out;
  }, [out]);
  return (
    <>
      {d.bytes != null && d.bytes > out.length && <p className="dim">Showing the first {bytes(out.length)} of {bytes(d.bytes)}.</p>}
      <pre className="dv-pre">{pretty}</pre>
    </>
  );
}
