import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./tauri";

/**
 * The context window and the account's usage limits, from what Claude Code tells its status line
 * (src-tauri/src/statusline.rs). Only there when "Show usage limits" is on.
 */
export interface Cap {
  usedPct: number;
  /** Unix ms. */
  resetsAt: number | null;
}

export interface Usage {
  window: number | null;
  contextPct: number | null;
  effort: string | null;
  fiveHour: Cap | null;
  sevenDay: Cap | null;
  limitsAt: number | null;
  modelWindows: [string, number][];
}

export interface LimitsStatus {
  installed: boolean;
  settings: string;
  error: string | null;
}

export const limitsStatus = () => invoke<LimitsStatus>("limits_status");
export const setLimits = (on: boolean) => invoke<void>("limits_set", { on });

let installed: boolean | null = null;
const installedSubs = new Set<(v: boolean) => void>();

/** Whether "Show usage limits" is on (checked once, and after each change). */
export function useLimitsInstalled(): boolean | null {
  const [v, setV] = useState(installed);
  useEffect(() => {
    installedSubs.add(setV);
    if (installed === null && IN_TAURI) void refreshLimitsInstalled();
    return () => void installedSubs.delete(setV);
  }, []);
  return v;
}

export async function refreshLimitsInstalled() {
  try {
    installed = (await limitsStatus()).installed;
  } catch {
    installed = false;
  }
  installedSubs.forEach((f) => f(installed!));
}

/** The snapshot for a session, refreshed every few seconds (Claude Code updates it each reply). */
export function useUsage(session: string | null): Usage | null {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    if (!IN_TAURI) return;
    let stop = false;
    const load = () =>
      void invoke<Usage>("usage", { session })
        .then((r) => !stop && setU(r))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [session]);
  return u;
}

/**
 * The session's context window in tokens: its own snapshot's, else one seen for the same model,
 * else a guess (1M when the model says so or more than 200k is in use, else 200k).
 */
export function contextWindow(u: Usage | null, model: string | null, used: number): { size: number; exact: boolean } {
  if (u?.window) return { size: u.window, exact: true };
  const seen = model ? u?.modelWindows.find(([m]) => m === model)?.[1] : undefined;
  if (seen && seen >= used) return { size: seen, exact: true };
  return { size: model?.includes("[1m]") || used > 200_000 ? 1_000_000 : 200_000, exact: false };
}

/** "14:30" later today, "Thu 10:30" another day. */
export function resetTime(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
