import { useEffect, useState } from "react";
import { limitsStatus, refreshLimitsInstalled, setLimits, type LimitsStatus } from "../lib/usage";
import { Dialog } from "./Dialog";

/** Turn "Show usage limits" on or off: AgentBoat's status line, wrapping yours. */
export function LimitsDialog({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<LimitsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void limitsStatus().then(setSt).catch((e) => setErr(String(e)));
  useEffect(load, []);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await setLimits(on);
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
    load();
    void refreshLimitsInstalled();
  };
  const on = !!st?.installed;
  return (
    <Dialog
      title="Show usage limits"
      onClose={onClose}
      width={540}
      footer={
        <>
          {on ? (
            <button className="btn" disabled={busy} onClick={() => void toggle(false)}>
              Turn off
            </button>
          ) : (
            <button className="btn primary" disabled={busy || !st} onClick={() => void toggle(true)}>
              Turn on
            </button>
          )}
          <span className="ny-fill" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p>
        The status bar can show your <b>5-hour</b> and <b>weekly</b> usage with when each resets, and the exact size of each session's context
        window. Claude Code tells these only to its status line, so AgentBoat becomes the status line and keeps a copy.
      </p>
      <p className="dim">
        AgentBoat sets <code>statusLine</code> in <code>{st?.settings || "~/.claude/settings.json"}</code> to run itself: it saves what Claude Code
        sends, then runs the status line you had, so your terminal looks the same. Turning this off puts yours back exactly as it was. Figures
        update after each reply; sessions started before you turn it on update after their next reply.
      </p>
      <div className="ny-status">
        <span className={`st-dot ${on ? "s-idle" : "s-ended"}`} />
        {!st ? "Checking…" : on ? "On." : "Off."}
      </div>
      {(err || st?.error) && <div className="ny-callout err">{err ?? st?.error}</div>}
    </Dialog>
  );
}
