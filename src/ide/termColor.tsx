import { memo, type ReactNode } from "react";

/**
 * Colour for the terminal, the way a developer's terminal has it.
 *
 * - Commands are highlighted as zsh-syntax-highlighting or PSReadLine would: the program, flags,
 *   strings, variables, operators, comments; heredoc bodies dimmed.
 * - Output keeps real ANSI colours when a program printed them. Most commands Claude runs print
 *   none (its shell isn't a TTY), so plain output is coloured by what its lines say: errors,
 *   warnings, passes, `file:line` locations, diffs and `git status`, as the tools themselves would
 *   when run in a terminal.
 */

export interface Tok {
  text: string;
  cls: string;
}

// ---------- commands ----------

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "foreach", "return", "break", "continue"]);

/** Tokens of a shell command, covering it exactly (joined, they give back the text). */
export function highlightCommand(cmd: string, powershell: boolean): Tok[] {
  const out: Tok[] = [];
  const push = (text: string, cls: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };
  let i = 0;
  let expectCmd = true;
  const heredocTags: string[] = [];
  while (i < cmd.length) {
    const c = cmd[i];
    // A heredoc body: everything from the next line to its tag.
    if (c === "\n" && heredocTags.length) {
      push("\n", "");
      i++;
      while (heredocTags.length && i < cmd.length) {
        const tag = heredocTags[0];
        const end = cmd.indexOf("\n", i);
        const line = cmd.slice(i, end < 0 ? cmd.length : end);
        if (line.trim() === tag) {
          push(line, "tk-op");
          heredocTags.shift();
        } else push(line, "tk-heredoc");
        i = end < 0 ? cmd.length : end;
        if (heredocTags.length && i < cmd.length) {
          push("\n", "");
          i++;
        }
      }
      expectCmd = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push(c, "");
      i++;
      continue;
    }
    if (c === "\n") {
      push(c, "");
      i++;
      expectCmd = true;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
      const end = cmd.indexOf("\n", i);
      push(cmd.slice(i, end < 0 ? cmd.length : end), "tk-comment");
      i = end < 0 ? cmd.length : end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== c) j += cmd[j] === "\\" && c === '"' ? 2 : 1;
      push(cmd.slice(i, Math.min(j + 1, cmd.length)), "tk-str");
      i = j + 1;
      expectCmd = false;
      continue;
    }
    if (c === "$") {
      // $VAR, ${VAR}, $(…) opening, $env:NAME, $_.
      const m = /^\$(\{[^}]*\}|\(|env:[\w]+|[\w?@#*!_-]+|_)/.exec(cmd.slice(i));
      const t = m ? m[0] : "$";
      push(t, "tk-var");
      i += t.length;
      if (t === "$(") expectCmd = true;
      continue;
    }
    // Operators.
    const op = /^(\|\||&&|2>&1|&>|>>|2>|1>|<<-?|[|;&<>()])/.exec(cmd.slice(i));
    if (op) {
      push(op[0], "tk-op");
      i += op[0].length;
      if (op[0].startsWith("<<")) {
        // The heredoc's tag: <<'EOF', <<"EOF", <<EOF.
        const tagm = /^\s*(['"]?)(\w+)\1/.exec(cmd.slice(i));
        if (tagm) {
          push(tagm[0], "tk-str");
          heredocTags.push(tagm[2]);
          i += tagm[0].length;
        }
        continue;
      }
      if (["|", "||", "&&", ";", "&", "("].includes(op[0])) expectCmd = true;
      continue;
    }
    // A word.
    let j = i;
    while (j < cmd.length && !/[\s'"$|;&<>()]/.test(cmd[j])) j++;
    const word = cmd.slice(i, j);
    let cls = "tk-arg";
    if (expectCmd && /^\w+=/.test(word)) cls = "tk-var";
    else if (expectCmd) {
      cls = KEYWORDS.has(word) ? "tk-kw" : "tk-cmd";
      if (!KEYWORDS.has(word)) expectCmd = false;
    } else if (/^--?[\w-]/.test(word)) cls = "tk-flag";
    else if (/^-?\d+(\.\d+)?$/.test(word)) cls = "tk-num";
    else if (powershell && /^[A-Z][a-z]+-[A-Z]\w+$/.test(word)) cls = "tk-cmd";
    push(word, cls);
    i = j > i ? j : i + 1;
  }
  return out;
}

/** The first `n` characters of a token list (the typing animation). */
export function sliceTokens(toks: Tok[], n: number): Tok[] {
  const out: Tok[] = [];
  let left = n;
  for (const t of toks) {
    if (left <= 0) break;
    out.push(t.text.length <= left ? t : { text: t.text.slice(0, left), cls: t.cls });
    left -= t.text.length;
  }
  return out;
}

export function Tokens({ toks }: { toks: Tok[] }) {
  return (
    <>
      {toks.map((t, k) =>
        t.cls ? (
          <span key={k} className={t.cls}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </>
  );
}

// ---------- output ----------

const SGR_FG: Record<number, string> = {
  30: "a-0", 31: "a-1", 32: "a-2", 33: "a-3", 34: "a-4", 35: "a-5", 36: "a-6", 37: "a-7",
  90: "a-8", 91: "a-9", 92: "a-10", 93: "a-11", 94: "a-12", 95: "a-13", 96: "a-14", 97: "a-15",
};

/** Output with ANSI colour codes as styled spans (other escape sequences dropped). */
function fromAnsi(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let fg = "";
  let bold = false;
  let dim = false;
  let last = 0;
  let k = 0;
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
  const emit = (s: string) => {
    if (!s) return;
    const cls = [fg, bold ? "a-bold" : "", dim ? "a-dim" : ""].filter(Boolean).join(" ");
    out.push(cls ? <span key={k++} className={cls}>{s}</span> : s);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let c = 0; c < codes.length; c++) {
      const n = codes[c];
      if (n === 0) [fg, bold, dim] = ["", false, false];
      else if (n === 1) bold = true;
      else if (n === 2) dim = true;
      else if (n === 22) [bold, dim] = [false, false];
      else if (n === 39) fg = "";
      else if (SGR_FG[n]) fg = SGR_FG[n];
      else if (n === 38 && codes[c + 1] === 5) {
        // 256 colours: the first 16 map onto the palette; others come out as the nearest basic hue.
        const v = codes[c + 2];
        fg = v < 16 ? `a-${v}` : "a-6";
        c += 2;
      } else if (n === 38 && codes[c + 1] === 2) c += 4;
      else if (n === 48 && (codes[c + 1] === 5 || codes[c + 1] === 2)) c += codes[c + 1] === 5 ? 2 : 4;
    }
  }
  emit(text.slice(last));
  return out;
}

/** The class a plain output line gets from what it says. */
function lineClass(line: string, ctx: { diff: boolean; gitStatus: boolean }): string {
  const t = line.trimStart();
  if (ctx.diff) {
    if (t.startsWith("+++") || t.startsWith("---") || t.startsWith("diff --git") || t.startsWith("index ")) return "o-bold";
    if (t.startsWith("@@")) return "o-hunk";
    if (line.startsWith("+")) return "o-add";
    if (line.startsWith("-")) return "o-del";
  }
  if (ctx.gitStatus) {
    if (/^\s*(modified|renamed|typechange):/.test(line)) return "o-warn";
    if (/^\s*new file:/.test(line)) return "o-ok";
    if (/^\s*deleted:/.test(line)) return "o-err";
    if (/^\s*[MADRCU?]{1,2} /.test(line) && line.length < 300) {
      const s = line.trimStart()[0];
      return s === "?" || s === "A" ? "o-ok" : s === "D" ? "o-err" : "o-warn";
    }
  }
  if (/^Exit code [1-9]/.test(t)) return "o-err";
  if (/^(error|fatal|panic|exception|traceback)\b|^\s*error(\[\w+\])?:|^\w*Error\b|\bpanicked at\b|test result: FAILED|^FAIL\b|^\s*FAILED\b|^npm ERR!|^\s*✗|^\s*×|^\s*✕|could not compile|No such file or directory|command not found|is not recognized as/i.test(t)) return "o-err";
  if (/^(warning|warn)\b|^\s*warning(\[\w+\])?:|^npm WARN|^\(!\)|deprecated/i.test(t)) return "o-warn";
  if (/^test result: ok|^\s*✓|^\s*✔|^\s*(Finished|Compiled|Successfully|Done|PASS)\b|\bpassed\b.*\b0 failed\b|^ok\b|^\s*Running .*\.exe`?$|^To https?:|^\s*[0-9a-f]{7,}\.\.[0-9a-f]{7,}\s/.test(t)) return "o-ok";
  if (/^\s*(Compiling|Downloading|Downloaded|Installing|Updating|Checking|Building|Bundling|Info)\b/.test(t)) return "o-info";
  if (/^\s*(-->|at )\s/.test(t) || /^\s+\|/.test(line)) return "o-dim";
  return "";
}

/** `src/a.rs:12:5`, `D:\x\y.ts(3,4)`: locations, in the colour terminals use for paths. */
function withLocations(line: string, key: number): ReactNode {
  const re = /((?:[A-Za-z]:)?[\w.\\/~-]*[\\/][\w.-]+\.\w+)([:(]\d+(?:[:,]\d+)?\)?)/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    parts.push(line.slice(last, m.index));
    parts.push(
      <span key={k++} className="o-loc" data-path={m[1]} data-line={/\d+/.exec(m[2])?.[0]}>
        {m[0]}
      </span>,
    );
    last = re.lastIndex;
  }
  if (!parts.length) return line;
  parts.push(line.slice(last));
  return <span key={key}>{parts}</span>;
}

/** Terminal output, coloured. */
export const TermOutput = memo(function TermOutput({ text }: { text: string }) {
  if (text.includes("\x1b[")) return <>{fromAnsi(text)}</>;
  const lines = text.split("\n");
  const ctx = {
    diff: /^diff --git |^@@ -\d/m.test(text),
    gitStatus: /^On branch |^Changes (not staged|to be committed)|^Untracked files:/m.test(text),
  };
  return (
    <>
      {lines.map((l, k) => {
        const cls = lineClass(l, ctx);
        const body = cls === "" || cls === "o-dim" ? withLocations(l, k) : l;
        const nl = k < lines.length - 1 ? "\n" : "";
        return cls ? (
          <span key={k} className={cls}>
            {body}
            {nl}
          </span>
        ) : (
          <span key={k}>
            {body}
            {nl}
          </span>
        );
      })}
    </>
  );
});
