/** A small coloured file-type badge, the way IDEs mark files by language. */

const TYPES: Record<string, [string, string]> = {
  ts: ["TS", "#3178c6"],
  tsx: ["TSX", "#3178c6"],
  mts: ["TS", "#3178c6"],
  js: ["JS", "#d4a72c"],
  jsx: ["JSX", "#d4a72c"],
  mjs: ["JS", "#d4a72c"],
  cjs: ["JS", "#d4a72c"],
  rs: ["RS", "#d0743c"],
  py: ["PY", "#3b77a8"],
  go: ["GO", "#00a7d0"],
  java: ["JV", "#c4532d"],
  kt: ["KT", "#8f63e6"],
  cs: ["C#", "#6a4fbf"],
  c: ["C", "#5c7fb5"],
  h: ["H", "#5c7fb5"],
  cpp: ["C++", "#5c7fb5"],
  php: ["PHP", "#7a86b8"],
  rb: ["RB", "#c0392b"],
  swift: ["SW", "#f05138"],
  json: ["{ }", "#c99a2e"],
  jsonl: ["{ }", "#c99a2e"],
  yaml: ["YML", "#cb4b5f"],
  yml: ["YML", "#cb4b5f"],
  toml: ["TML", "#9c6b4e"],
  md: ["MD", "#4a8bc2"],
  mdx: ["MDX", "#4a8bc2"],
  html: ["<>", "#e3633b"],
  css: ["#", "#5a69c8"],
  scss: ["#", "#c6538c"],
  sql: ["SQL", "#d08b2d"],
  sh: ["$", "#5aa05a"],
  bash: ["$", "#5aa05a"],
  ps1: ["PS", "#3c7fc1"],
  txt: ["TXT", "#8a887f"],
  lock: ["LCK", "#8a887f"],
  env: ["ENV", "#9a9a3a"],
  svg: ["SVG", "#d3a321"],
  png: ["IMG", "#3d9a7a"],
  jpg: ["IMG", "#3d9a7a"],
  jpeg: ["IMG", "#3d9a7a"],
  gif: ["IMG", "#3d9a7a"],
  webp: ["IMG", "#3d9a7a"],
  pdf: ["PDF", "#c0392b"],
  vue: ["VUE", "#41b883"],
  svelte: ["SV", "#ff3e00"],
  xml: ["XML", "#e3633b"],
  ini: ["INI", "#8a887f"],
  dockerfile: ["DK", "#2496ed"],
};

export function FileIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  const ext = lower === "dockerfile" ? "dockerfile" : lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const [label, color] = TYPES[ext] ?? ["", "#8a887f"];
  return (
    <span className="file-icon" style={{ color }} aria-hidden="true">
      {label || (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M4 1.8h5l3.2 3.2v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z" />
        </svg>
      )}
    </span>
  );
}
