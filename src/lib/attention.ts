import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "./tauri";

/**
 * "Needs you": every running session waiting on you (src-tauri/src/attention.rs). Prompts
 * (`permission`, `question`, `plan`) come from Claude Code's hook and are answered here;
 * `waiting` (a prompt in its terminal AgentBoat can't see) and `done` (finished its turn) can only be
 * opened.
 */
export type AttentionKind = "permission" | "question" | "plan" | "waiting" | "done";

export interface Suggestion {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  destination?: string;
  mode?: string;
  directories?: string[];
}

export interface AttentionItem {
  id: number;
  kind: AttentionKind;
  sessionId: string;
  cwd: string | null;
  folder: string;
  title: string | null;
  transcript: string | null;
  agentType: string | null;
  tool: string | null;
  mcpServer: string | null;
  input: Record<string, unknown> | null;
  suggestions: Suggestion[] | null;
  waitingFor: string | null;
  at: number;
}

export type Answer =
  | { kind: "allow"; always?: boolean }
  | { kind: "deny"; message?: string; interrupt?: boolean }
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "approve"; always?: boolean }
  | { kind: "release" };

export const isRequest = (i: AttentionItem) => i.kind === "permission" || i.kind === "question" || i.kind === "plan";

let items: AttentionItem[] = [];
const subs = new Set<() => void>();
const set = (next: AttentionItem[]) => {
  items = next;
  subs.forEach((f) => f());
};

export function useAttention(): AttentionItem[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => items,
  );
}

export function startAttention() {
  if (!IN_TAURI) return;
  void listen<AttentionItem[]>("ccb:attention", (e) => set(e.payload));
  void invoke<AttentionItem[]>("attention_list").then(set).catch(() => {});
}

export const answer = (id: number, a: Answer) => invoke<void>("attention_answer", { id, answer: a });
export const dismiss = (id: number) => invoke<void>("attention_dismiss", { id });

export interface HookStatus {
  installed: boolean;
  current: boolean;
  listening: boolean;
  port: number;
  error: string | null;
  settings: string;
}

export const hookStatus = () => invoke<HookStatus>("hook_status");
export const setHook = (on: boolean) => invoke<void>("hook_set", { on });

/** Take you to the session in a terminal: its window if it's running, else `claude --resume`. */
export const openInClaudeCode = (id: string, cwd: string | null) =>
  invoke<"focused" | "opened">("open_in_claude_code", { id, cwd });
