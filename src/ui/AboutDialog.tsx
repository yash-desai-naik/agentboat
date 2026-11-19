import { useEffect, useState } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { IS_MAC } from "../lib/tauri";
import { settings, useSettings } from "../lib/settings";
import { checkForUpdates, installUpdate, useUpdate } from "../lib/update";
import { Dialog } from "./Dialog";

interface AppPaths {
  dataDir: string;
  exe: string;
  claudeDir: string;
}

/** Version, build, where AgentBoat keeps things, and updates. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  const [tauri, setTauri] = useState("?");
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [copied, setCopied] = useState(false);
  const { checkUpdates } = useSettings();
  const update = useUpdate();
  const b = __APP_BUILD__;
  const ua = navigator.userAgent;
  const webview = (IS_MAC ? (/Version\/([\d.]+)/.exec(ua)?.[1] ?? /AppleWebKit\/([\d.]+)/.exec(ua)?.[1]) : /Edg\/([\d.]+)/.exec(ua)?.[1]) ?? "?";

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion("?"));
    void getTauriVersion()
      .then(setTauri)
      .catch(() => {});
    void invoke<AppPaths>("app_paths")
      .then(setPaths)
      .catch(() => {});
  }, []);

  const rows: [string, string][] = [
    ["Version", version ?? "…"],
    ["Build", `${b.commit}${b.dirty ? " (with uncommitted changes)" : ""}${b.dev ? " · development run" : ""}`],
    ["Built", new Date(b.date).toLocaleString()],
    ["Tauri", tauri],
    [IS_MAC ? "WebKit" : "WebView2", webview],
  ];
  const details = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(paths ? [`Program: ${paths.exe}`, `Data: ${paths.dataDir}`, `Sessions: ${paths.claudeDir}`] : []),
  ].join("\n");
  const busy = update.phase === "downloading" || update.phase === "installing";

  return (
    <Dialog
      title="About AgentBoat"
      onClose={onClose}
      width={580}
      footer={
        <>
          <button className="btn" onClick={() => void invoke("open_repo_page").catch(() => {})}>
            GitHub
          </button>
          <button
            className="btn"
            onClick={() =>
              void navigator.clipboard.writeText(details).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? "Copied" : "Copy details"}
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="about-head">
        <img src="/icon.svg" width={48} height={48} alt="" />
        <div>
          <div className="about-name">AgentBoat {version ?? ""}</div>
          <div className="dim small">Watch a Claude Code session as a read-only IDE, live or replayed step by step.</div>
          <div className="dim small">MIT License. It only reads; the one thing it fetches is the update check below.</div>
          <div className="about-update">
            {update.info ? (
              <>
                <span>Version {update.info.version} is available.</span>
                <button className="btn primary small-btn" disabled={busy} onClick={() => void installUpdate()}>
                  Install and restart
                </button>
              </>
            ) : (
              <>
                <button className="btn small-btn" disabled={update.phase === "checking"} onClick={() => void checkForUpdates()}>
                  {update.phase === "checking" ? "Checking…" : "Check for updates"}
                </button>
                {update.phase === "uptodate" && <span className="dim small">You're up to date.</span>}
                {update.phase === "error" && <span className="small err-text">{update.error}</span>}
              </>
            )}
          </div>
          <label className="about-check">
            <input type="checkbox" checked={checkUpdates} onChange={(e) => settings.set({ checkUpdates: e.target.checked })} />
            Check for updates automatically (at start-up and once a day)
          </label>
        </div>
      </div>
      <table className="kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td className="mono">{v}</td>
            </tr>
          ))}
          {paths && (
            <>
              <tr>
                <th>Program</th>
                <td className="mono">{paths.exe}</td>
              </tr>
              <tr>
                <th>Data</th>
                <td className="mono">
                  {paths.dataDir}{" "}
                  <button className="link-btn" onClick={() => void invoke("open_app_folder", { which: "data" })}>
                    Open
                  </button>
                  <div className="dim small">View settings and the session opened last</div>
                </td>
              </tr>
              <tr>
                <th>Sessions</th>
                <td className="mono">
                  {paths.claudeDir}{" "}
                  <button className="link-btn" onClick={() => void invoke("open_app_folder", { which: "claude" })}>
                    Open
                  </button>
                  <div className="dim small">Claude Code's own folder, read but never changed</div>
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </Dialog>
  );
}
