import type { Ide } from "../lib/derive";
import { duration, shortTool, tokens } from "../lib/format";
import { setWatch, useSession } from "../lib/store";
import { agentName } from "../lib/derive";
import type { Head } from "../lib/types";
import { Branch } from "../ui/Icons";
import { useNow } from "../lib/clock";
import { settings, useSettings } from "../lib/settings";

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

export function StatusBar({ ide, head }: { ide: Ide; head: Head | null }) {
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
      {head && head.meta.contextTokens > 0 && <span className="sb-item" title="Context in use at the last request">ctx {tokens(head.meta.contextTokens)}</span>}
      {head?.meta.model && (
        <span className="sb-item" title={head.meta.version ? `Claude Code ${head.meta.version}` : undefined}>
          {head.meta.model.replace(/^claude-/, "")}
        </span>
      )}
    </footer>
  );
}
