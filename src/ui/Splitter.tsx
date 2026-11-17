/**
 * A drag handle on the edge of a pane. `edge` says which side of the pane it's on, so dragging
 * outward grows the pane.
 */
export function Splitter({
  dir,
  value,
  min,
  max,
  onChange,
  edge,
}: {
  dir: "x" | "y";
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  edge: "left" | "right" | "top";
}) {
  return (
    <div
      className={`splitter ${dir} edge-${edge}`}
      onPointerDown={(e) => {
        e.preventDefault();
        const start = dir === "x" ? e.clientX : e.clientY;
        const from = value;
        const sign = edge === "right" ? 1 : -1;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        const move = (ev: PointerEvent) => {
          const d = (dir === "x" ? ev.clientX : ev.clientY) - start;
          onChange(Math.round(Math.max(min, Math.min(max, from + sign * d))));
        };
        const up = () => {
          el.classList.remove("dragging");
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}
