import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp } from "./Icons";

/** How far from an end the view must be before the jump to it is offered, in pixels. */
const SLACK = 40;

interface Where {
  up: boolean;
  down: boolean;
  right: number;
  bottom: number;
}

/**
 * Tiny "jump to top / end" buttons in the bottom-right corner of a scrolling area, shown while the
 * pointer is over it and only for an end it is away from. They float over the area (fixed, in a
 * portal), so they need no room in its layout. `selector` finds the element that actually scrolls
 * inside `target` (CodeMirror's `.cm-scroller`, say); without it, `target` itself scrolls.
 */
export function ScrollJump({ target, selector }: { target: React.RefObject<HTMLElement | null>; selector?: string }) {
  const [where, setWhere] = useState<Where | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const over = useRef({ area: false, buttons: false });
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const root = target.current;
    if (!root) return;
    let poll: number | null = null;
    const measure = () => {
      const el = scroller.current;
      if (!el || !(over.current.area || over.current.buttons)) return setWhere(null);
      const r = el.getBoundingClientRect();
      const up = el.scrollTop > SLACK;
      const down = el.scrollHeight - el.clientHeight - el.scrollTop > SLACK;
      // Inside the area's corner, clear of its scrollbar.
      const bar = el.offsetWidth - el.clientWidth;
      setWhere(up || down ? { up, down, right: window.innerWidth - r.right + bar + 8, bottom: window.innerHeight - r.bottom + 8 } : null);
    };
    const stop = () => {
      scroller.current?.removeEventListener("scroll", measure);
      if (poll) window.clearInterval(poll);
      poll = null;
    };
    const enter = () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      over.current.area = true;
      // The element that scrolls can be made after the area (an editor's view): find it each time.
      const el = selector ? root.querySelector<HTMLElement>(selector) : root;
      if (el !== scroller.current) stop();
      scroller.current = el;
      if (!el) return;
      if (!poll) {
        el.addEventListener("scroll", measure, { passive: true });
        // Content grows while it is watched (a live session): look again now and then.
        poll = window.setInterval(measure, 500);
      }
      measure();
    };
    const leave = () => {
      over.current.area = false;
      // A moment's grace to reach the buttons, which are outside the area's elements.
      hideTimer.current = window.setTimeout(() => {
        if (over.current.buttons) return;
        stop();
        setWhere(null);
      }, 200);
    };
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", leave);
    window.addEventListener("resize", measure);
    return () => {
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", measure);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      stop();
    };
  }, [target, selector]);

  if (!where) return null;
  const jump = (top: boolean) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: top ? 0 : el.scrollHeight, behavior: "smooth" });
  };
  return createPortal(
    <div
      className="scroll-jump"
      style={{ right: where.right, bottom: where.bottom }}
      onPointerEnter={() => {
        over.current.buttons = true;
        if (hideTimer.current) window.clearTimeout(hideTimer.current);
      }}
      onPointerLeave={() => {
        over.current.buttons = false;
        if (!over.current.area) setWhere(null);
      }}
    >
      {where.up && (
        <button onClick={() => jump(true)} title="Jump to top" aria-label="Jump to top">
          <ArrowUp size={12} />
        </button>
      )}
      {where.down && (
        <button onClick={() => jump(false)} title="Jump to end" aria-label="Jump to end">
          <ArrowDown size={12} />
        </button>
      )}
    </div>,
    document.body,
  );
}
