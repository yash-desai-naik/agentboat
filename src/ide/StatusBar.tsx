import type { Ide } from "../lib/derive";
import { duration, shortTool, tokens } from "../lib/format";
import { setWatch, useSession } from "../lib/store";
import { agentName } from "../lib/derive";
import type { Head } from "../lib/types";
import { Branch } from "../ui/Icons";
import { useNow } from "../lib/clock";
import { settings, useSettings } from "../lib/settings";
import { contextWindow, resetTime, useLimitsInstalled, useUsage, type Cap, type Usage } from "../lib/usage";

const STATUS_TEXT: Record<string, string> = {
  working: "Working",
  waiting: "Needs you",
  idle: "Idle",
  active: "Active",
  ended: "Ended",
};

/** The permission mode in words; nothing for the default. */
function permissionLabel(m: string | null): string | null {
  switch (m) {
    case null:
    case "default":
      return null;
    case "acceptEdits":
      return "accept edits";
    case "bypassPermissions":
      return "bypass permissions";
    case "plan":
      return "plan mode";
    case "auto":
      return "auto mode";
    default:
      return m;
  }
}

export function StatusBar({ ide, head, onLimits }: { ide: Ide; head: Head | null; onLimits: () => void }) {
  const usage = useUsage(head?.id ?? null);
  const limitsOn = useLimitsInstalled();
  const effort = head?.meta.effort ?? usage?.effort ?? null;
  const { follow, playing, cursor, steps, watch } = useSession();
  const { showTimeline } = useSettings();
  const now = useNow();
  const status = head?.status ?? "ended";
  const atEnd = cursor >= steps.length - 1;
  const running = ide.running[0];
  const mode = permissionLabel(head?.meta.permissionMode ?? null);
  // When the view isn't showing the present (replaying, or an earlier step) and the timeline that
  // would say so is hidden. Following live is the normal state and needs no label.
  const where = showTimeline || follow ? null : playing ? "replay" : atEnd ? null : "past";
  const turnErrors = (() => {
    let n = 0;
    for (let i = Math.min(cursor, steps.length - 1); i >= 0; i--) {
      const s = steps[i];
      if (s.kind === "prompt" && s.agent === 0) break;
      if (s.state === "err" && s.kind === "tool") n++;
    }
    return n;
  })();
  return (
    <footer className={`statusbar s-${status}`}>
      <span className={`sb-item sb-status s-${status}`} title={head?.waitingFor ? `Waiting for: ${head.waitingFor}` : undefined}>
        <span className="sb-dot" /> {STATUS_TEXT[status] ?? status}
        {status === "waiting" && head?.waitingFor ? `: ${head.waitingFor}` : ""}
      </span>
      {where && (
        <button className={`sb-where w-${where}`} onClick={() => settings.set({ showTimeline: true })} title="Show the timeline (Ctrl+T)">
          {where === "replay" ? "▶ Replay" : `❚❚ Step ${cursor + 1} of ${steps.length}`}
        </button>
      )}
      {ide.branch && (
        <span className="sb-item" title="Branch">
          <Branch size={13} /> {ide.branch}
          {ide.ahead > 0 && <span title="Commits not pushed"> ↑{ide.ahead}</span>}
        </span>
      )}
      {turnErrors > 0 && (
        <span className="sb-item sb-err" title="Failed tool calls this turn">
          ✕ {turnErrors}
        </span>
      )}
      {running && (
        <span className="sb-item sb-running ellipsis">
          <span className="spinner" /> {shortTool(running.tool)}
          {running.label && !running.label.startsWith(shortTool(running.tool)) ? `: ${running.label}` : ""}
          {follow && atEnd ? ` · ${duration(now - running.ts)}` : ""}
          {ide.running.length > 1 ? ` (+${ide.running.length - 1})` : ""}
        </span>
      )}
      {watch > 0 && (
        <button className="sb-where" onClick={() => setWatch(0)} title="Back to Claude's screen (Esc)">
          👁 {agentName(head, watch)}
        </button>
      )}
      <span className="sb-fill" />
      {mode && <span className="sb-item" title="Permission mode">{mode}</span>}
      {head && head.meta.contextTokens > 0 && <ContextMeter used={head.meta.contextTokens} model={head.meta.model} usage={usage} />}
      <Limits usage={usage} on={limitsOn} now={now} onSetup={onLimits} />
      {head?.meta.model && (
        <span className="sb-item" title={head.meta.version ? `Claude Code ${head.meta.version}` : undefined}>
          {head.meta.model.replace(/^claude-/, "")}
          {effort && <span className="sb-effort" title="Reasoning effort of the last reply"> · {effort}</span>}
        </span>
      )}
    </footer>
  );
}

const hot = (pct: number) => (pct >= 80 ? " hot" : "");

function Meter({ pct }: { pct: number }) {
  return (
    <span className={`sb-meter${hot(pct)}`} aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

/** Context in use at the last request, as a share of the window, with a bar. */
function ContextMeter({ used, model, usage }: { used: number; model: string | null; usage: Usage | null }) {
  const { size, exact } = contextWindow(usage, model, used);
  const pct = (100 * used) / size;
  const note = exact ? "" : " (window size estimated: turn on Show usage limits for the exact one)";
  return (
    <span className={`sb-item sb-ctx${hot(pct)}`} title={`Context in use at the last request: ${tokens(used)} of ${exact ? "" : "about "}${tokens(size)} tokens${note}`}>
      ctx <Meter pct={pct} /> {exact ? "" : "≈"}
      {Math.round(pct)}%
    </span>
  );
}

/** The account's 5-hour and 7-day usage with when each resets; a way to turn them on when off. */
function Limits({ usage, on, now, onSetup }: { usage: Usage | null; on: boolean | null; now: number; onSetup: () => void }) {
  const caps: [string, string, Cap | null][] = [
    ["5h", "5-hour limit", usage?.fiveHour ?? null],
    ["7d", "Weekly limit", usage?.sevenDay ?? null],
  ];
  if (!caps.some(([, , c]) => c)) {
    if (on)
      return (
        <span className="sb-item dim" title="Usage limits appear after the next reply in any session">
          5h · 7d …
        </span>
      );
    return (
      <button className="sb-where sb-limits-off" onClick={onSetup} title="Show the 5-hour and weekly usage limits">
        5h · 7d
      </button>
    );
  }
  const asOf = usage?.limitsAt ? ` (as of ${resetTime(usage.limitsAt)})` : "";
  return (
    <>
      {caps.map(([key, name, c]) => {
        if (!c) return null;
        const reset = c.resetsAt ?? 0;
        if (reset && reset <= now)
          return (
            <span key={key} className="sb-item dim" title={`${name}: reset at ${resetTime(reset)}; new figures come with the next reply`}>
              {key} reset
            </span>
          );
        return (
          <span key={key} className={`sb-item sb-cap${hot(c.usedPct)}`} title={`${name}: ${Math.round(c.usedPct)}% used${reset ? `, resets ${resetTime(reset)}` : ""}${asOf}`}>
            {key} <Meter pct={c.usedPct} /> {Math.round(c.usedPct)}%{reset ? <span className="sb-reset"> ⟳ {resetTime(reset)}</span> : null}
          </span>
        );
      })}
    </>
  );
}
