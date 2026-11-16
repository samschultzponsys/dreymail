// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The draggable right edge of a pane (folder bar, message list), with a small grip so it's clear it
// can be dragged. Double-click resets the width.

export function PaneResizer({
  label,
  min,
  max,
  onResize,
}: {
  label: string;
  /** Narrowest width (CSS px). */
  min: number;
  /** Widest width for the room there is right of the pane's left edge (CSS px). */
  max: (room: number) => number;
  onResize: (width: number | null, done: boolean) => void;
}) {
  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => onResize(null, true)}
      onPointerDown={(e) => {
        const pane = (e.currentTarget as HTMLElement).parentElement!;
        const app = pane.closest('.app') as HTMLElement;
        const zoom = Number(getComputedStyle(app).getPropertyValue('--ui-zoom')) || 1;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const left = pane.getBoundingClientRect().left;
        const room = (app.getBoundingClientRect().right - left) / zoom;
        const widthAt = (x: number) => Math.round(Math.min(Math.max((x - left) / zoom, min), Math.max(min, max(room))));
        const move = (ev: PointerEvent) => onResize(widthAt(ev.clientX), false);
        const up = (ev: PointerEvent) => {
          onResize(widthAt(ev.clientX), true);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    >
      <span className="pane-grip" aria-hidden="true" />
    </div>
  );
}
