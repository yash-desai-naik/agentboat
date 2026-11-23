import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, highlightActiveLine, highlightSpecialChars, lineNumbers, WidgetType } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { ScrollJump } from "../ui/ScrollJump";
import { frameDue } from "../lib/motion";

/**
 * A read-only CodeMirror editor that shows a file, a file's change as an inline diff, and, when
 * the change is happening live, the change being made: the old text selected and removed, the new
 * text typed in at a moving caret, then the diff.
 */

export const syntax = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.standard(t.name), t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number], color: "var(--syn-number)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--syn-literal)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.variableName, t.propertyName, t.special(t.name), t.attributeName], color: "var(--syn-property)" },
  { tag: [t.tagName], color: "var(--syn-keyword)" },
  { tag: [t.heading], color: "var(--syn-function)", fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--syn-string)", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction], color: "var(--syn-comment)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: "var(--syn-operator)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
]);

const chrome = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--editor-bg)", color: "var(--syn-operator)", fontSize: "var(--fs-code)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "4px 0 40vh" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--editor-gutter)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 18px", minWidth: "48px" },
  ".cm-activeLine": { backgroundColor: "var(--editor-current-line)" },
  ".cm-changedLine, .cm-insertedLine": { backgroundColor: "var(--edit-added)" },
  ".cm-deletedChunk, .cm-deletedLine": { backgroundColor: "var(--edit-deleted)" },
  ".cm-changedText": { background: "none", backgroundColor: "var(--edit-added-strong)" },
  ".cm-deletedChunk .cm-deletedText, del": { backgroundColor: "var(--edit-deleted-strong)", textDecoration: "none" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  ".cm-changedLineGutter": { backgroundColor: "var(--git-added)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--git-deleted)" },
});

// ---------- the typing caret and the marks around the change ----------

const setMarks = StateEffect.define<{ caret: number | null; typedFrom: number; typedTo: number; delFrom: number; delTo: number } | null>();

class CaretWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "ccb-caret";
    return s;
  }
  eq() {
    return true;
  }
}

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const v = e.value;
      if (!v) return Decoration.none;
      const out = [];
      const len = tr.state.doc.length;
      if (v.delTo > v.delFrom) out.push(Decoration.mark({ class: "ccb-deleting" }).range(Math.min(v.delFrom, len), Math.min(v.delTo, len)));
      if (v.typedTo > v.typedFrom) out.push(Decoration.mark({ class: "ccb-typed" }).range(Math.min(v.typedFrom, len), Math.min(v.typedTo, len)));
      if (v.caret !== null) out.push(Decoration.widget({ widget: new CaretWidget(), side: 1 }).range(Math.min(v.caret, len)));
      return Decoration.set(out, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- other agents on this file (presence) ----------

/** A collaborator's place in the file: a 1-based line of the doc, a name tag and its colour. */
export interface PresenceMark {
  line: number;
  label: string;
  hue: number;
}

const setPresence = StateEffect.define<PresenceMark[]>();

class NameTag extends WidgetType {
  constructor(
    readonly label: string,
    readonly hue: number,
  ) {
    super();
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "ccb-presence-tag";
    s.style.setProperty("--hue", String(this.hue));
    s.textContent = this.label;
    return s;
  }
  eq(o: NameTag) {
    return o.label === this.label && o.hue === this.hue;
  }
}

/** Kept as lines, not positions, and rebuilt when the doc changes (it's replaced wholesale). */
const presenceField = StateField.define<{ items: PresenceMark[]; deco: DecorationSet }>({
  create: () => ({ items: [], deco: Decoration.none }),
  update(v, tr) {
    let items = v.items;
    for (const e of tr.effects) if (e.is(setPresence)) items = e.value;
    if (items === v.items && !tr.docChanged) return v;
    const doc = tr.state.doc;
    const out = [];
    const sorted = [...items].filter((m) => m.line >= 1 && m.line <= doc.lines).sort((a, b) => a.line - b.line);
    for (const m of sorted) {
      const line = doc.line(m.line);
      out.push(Decoration.line({ attributes: { class: "ccb-presence-line", style: `--hue: ${m.hue}` } }).range(line.from));
    }
    for (const m of sorted) {
      const line = doc.line(m.line);
      out.push(Decoration.widget({ widget: new NameTag(m.label, m.hue), side: 1 }).range(line.to));
    }
    return { items, deco: Decoration.set(out, true) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// ---------- the component ----------

export interface Typing {
  /** performance.now() when the step became current, and how long it has on screen. */
  at: number;
  dur: number;
}

interface Props {
  /** The text to end with. */
  doc: string;
  /** When set, the doc is shown as a change from this. */
  original: string | null;
  /** File name, for the language. */
  name: string;
  /** The line number of the doc's first line (a partial read). */
  startLine: number;
  /** Animate the change from `original` (or from empty) to `doc`. */
  typing: Typing | null;
  /** Show the end of the file rather than the change (a terminal-like log). */
  wrap?: boolean;
  /** Other agents on this file, by line of the file (not of the doc). */
  presence?: PresenceMark[];
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");

/** Where two texts differ: [from, end in a, end in b). */
function changeRange(a: string, b: string) {
  const m = Math.min(a.length, b.length);
  let p = 0;
  while (p < m && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < m - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { from: p, toA: a.length - s, toB: b.length - s };
}

const languageCache = new Map<string, Promise<Extension | null>>();
function loadLanguage(name: string): Promise<Extension | null> {
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return Promise.resolve(null);
  let p = languageCache.get(desc.name);
  if (!p) {
    p = desc.load().catch(() => null);
    languageCache.set(desc.name, p);
  }
  return p;
}

export function CodeEditor({ doc, original, name, startLine, typing, wrap, presence }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const comp = useRef({
    lang: new Compartment(),
    gutter: new Compartment(),
    merge: new Compartment(),
    wrap: new Compartment(),
  });
  const shown = useRef<{ doc: string; original: string | null; startLine: number } | null>(null);

  useEffect(() => {
    const c = comp.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          c.gutter.of(lineNumbers()),
          highlightSpecialChars(),
          highlightActiveLine(),
          syntaxHighlighting(syntax),
          chrome,
          marks,
          presenceField,
          c.lang.of([]),
          c.merge.of([]),
          c.wrap.of([]),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // Language by file name (loaded once per language).
  useEffect(() => {
    let stale = false;
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: comp.current.lang.reconfigure([]) });
    void loadLanguage(name).then((ext) => {
      if (!stale && ext && view.current === v) v.dispatch({ effects: comp.current.lang.reconfigure(ext) });
    });
    return () => {
      stale = true;
    };
  }, [name]);

  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  // The content, and the animation when there is one.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const c = comp.current;
    const after = norm(doc);
    const before = original === null ? null : norm(original);
    const same = shown.current && shown.current.doc === after && shown.current.original === before && shown.current.startLine === startLine;
    if (same) return;
    shown.current = { doc: after, original: before, startLine };

    const gutter = lineNumbers({ formatNumber: (n) => String(n + startLine - 1) });

    const showFinal = () => {
      const merge = before !== null && before !== "" && before !== after ? unifiedMergeView({ original: before, mergeControls: false, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true }) : [];
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: after },
        effects: [c.merge.reconfigure(merge), c.gutter.reconfigure(gutter), setMarks.of(null)],
      });
      // The change in the middle of the screen; a plain file from its top.
      let pos = 0;
      if (before) pos = Math.min(changeRange(before, after).from, v.state.doc.length);
      const line = v.state.doc.lineAt(pos);
      v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: before ? "center" : "start" }) });
    };

    const remaining = typing ? typing.at + typing.dur - performance.now() : 0;
    const base = before ?? "";
    const r = changeRange(base, after);
    const typed = r.toB - r.from;
    // Animate only when there's time for it and the change is a size a person could type.
    if (!typing || remaining < 250 || typed > 6000 || (typed === 0 && r.toA === r.from)) {
      showFinal();
      return;
    }

    // Start from the text before, with the caret at the change.
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: base },
      effects: [c.merge.reconfigure([]), c.gutter.reconfigure(gutter), setMarks.of(null)],
    });
    const startPos = r.from;
    v.dispatch({
      selection: { anchor: startPos },
      effects: [
        EditorView.scrollIntoView(startPos, { y: "center" }),
        setMarks.of({ caret: startPos, typedFrom: 0, typedTo: 0, delFrom: r.from, delTo: r.toA }),
      ],
    });
    const insert = after.slice(r.from, r.toB);
    const t0 = performance.now();
    const total = Math.max(200, remaining * 0.85);
    // A beat with the old text selected (if any), then typing, then the diff.
    const delPhase = r.toA > r.from ? Math.min(260, total * 0.2) : 0;
    let deleted = r.toA === r.from;
    let done = 0;
    let raf = 0;
    const last = { t: 0 };
    const frame = () => {
      const now = performance.now();
      const el = now - t0;
      // At most ~30 redraws a second; the last step always draws.
      if (el < total && !frameDue(last, now)) {
        raf = requestAnimationFrame(frame);
        return;
      }
      if (!deleted && el >= delPhase) {
        v.dispatch({ changes: { from: r.from, to: r.toA, insert: "" }, effects: setMarks.of({ caret: r.from, typedFrom: r.from, typedTo: r.from, delFrom: 0, delTo: 0 }) });
        deleted = true;
      }
      if (deleted) {
        const p = Math.min(1, (el - delPhase) / Math.max(1, total - delPhase));
        const want = Math.round(insert.length * p);
        if (want > done) {
          const chunk = insert.slice(done, want);
          const at = r.from + done;
          done = want;
          v.dispatch({
            changes: { from: at, insert: chunk },
            effects: [setMarks.of({ caret: r.from + done, typedFrom: r.from, typedTo: r.from + done, delFrom: 0, delTo: 0 }), EditorView.scrollIntoView(r.from + done, { y: "nearest", yMargin: 80 })],
          });
        }
        if (p >= 1) {
          showFinal();
          return;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      // Interrupted (the next step came): make sure what's left is the final state next time.
      shown.current = null;
    };
    // `typing` changes identity each render; its fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, original, startLine, typing?.at, typing?.dur]);

  // Collaborators' lines: file lines to doc lines (a partial read starts further down).
  const presenceKey = JSON.stringify(presence ?? []) + ":" + startLine;
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const items = (presence ?? []).map((m) => ({ ...m, line: m.line - startLine + 1 }));
    v.dispatch({ effects: setPresence.of(items) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceKey]);

  return (
    <>
      <div className="code-editor" ref={host} />
      <ScrollJump target={host} selector=".cm-scroller" />
    </>
  );
}
