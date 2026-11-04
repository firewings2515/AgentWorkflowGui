// WB-04 (T056): dragging an ordinary session row onto another row moves it below that one (「移到…底下」), onto the
// zone at the top of the list moves it to the top (「移到最上層」). Mouse only; the keyboard keeps T053's context menu.
// What can be dropped where is worked out once, when the drag starts; a drop goes through the shell's moveSession,
// which checks the latest Snapshot again (canMove) and owns sending, errors and the stale message.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { SessionId } from '../../../../contracts';

/** Only this type is put on a drag, and only the session id; anything else (files, text, other apps) is ignored. */
export const SESSION_DRAG_TYPE = 'application/x-awg-session';
const ours = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes(SESSION_DRAG_TYPE);

/** One drag. The object itself is the drag's generation: later callbacks compare it with the current one. */
export interface SessionDrag { sessionId: SessionId; targets: ReadonlySet<string>; toTop: boolean }

export interface SessionDragOptions {
  /** Whether this row can start a drag now (ordinary, in the chat tree, not read-only, not moving). */
  canDrag: (id: SessionId) => boolean;
  /** Where the session can go, worked out once at the start; undefined refuses the drag. */
  start: (id: SessionId) => Omit<SessionDrag, 'sessionId'> | undefined;
  /** Whether a drag still makes sense in this render (the session is still shown and can move). */
  live: (drag: SessionDrag) => boolean;
  onDrop: (id: SessionId, parentId: SessionId | null) => void;
}

export function useSessionDrag({ canDrag, start, live, onDrop }: SessionDragOptions) {
  // `active` is what a drop trusts (set at once in dragstart); `shown` is what the list shows, one task later, since
  // Chromium may end a drag whose dragstart changes the page.
  const active = useRef<SessionDrag | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [shown, setShown] = useState<SessionDrag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const clear = useCallback(() => {
    active.current = null;
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    setShown(null);
    setOver(null);
  }, []);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);
  // A safety net while a drag is shown: a dragend or drop anywhere, or the first mouse move with no button held (none
  // comes during a native drag), ends it, also when the source row was unmounted and its own dragend never comes.
  // Bubble phase, so a row's drop handler runs before this clears the drag.
  useEffect(() => {
    if (!shown) return;
    const end = () => { if (active.current === shown) clear(); };
    const moved = (event: Event) => { if ((event as MouseEvent).buttons === 0) end(); };
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    window.addEventListener('pointermove', moved);
    return () => {
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
      window.removeEventListener('pointermove', moved);
    };
  }, [shown, clear]);

  // Worked out once per render: nothing shows (or accepts a drop) once the session is gone, pinned, read-only or moving.
  // `shown` and `active` are cleared together, and a new drag clears `shown` first, so a shown drag is the active one;
  // the handlers still check that it is.
  const current = shown && live(shown) ? shown : null;
  const accept = (event: DragEvent, key: string, allowed: boolean) => {
    if (!current || active.current !== current || !ours(event)) return;
    if (allowed) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(key); }
    else { event.dataTransfer.dropEffect = 'none'; setOver(null); }
  };
  const drop = (event: DragEvent, parentId: SessionId | null) => {
    if (!ours(event)) return;
    event.preventDefault();
    // The id is the one remembered here, never the string on the drag (r: it can come from anywhere).
    const drag = active.current;
    const allowed = !!drag && drag === current && (parentId === null ? drag.toTop : drag.targets.has(parentId));
    clear();
    if (allowed) onDrop(drag.sessionId, parentId);
  };

  return {
    dragging: current?.sessionId,
    /** Props for a row's main button: the drag source. */
    source: (id: SessionId) => ({
      draggable: canDrag(id),
      onDragStart: (event: DragEvent) => {
        const spec = canDrag(id) ? start(id) : undefined;
        if (!spec) { event.preventDefault(); return; }
        event.dataTransfer.setData(SESSION_DRAG_TYPE, id);
        event.dataTransfer.effectAllowed = 'move';
        const drag: SessionDrag = { sessionId: id, ...spec };
        clear();
        active.current = drag;
        timer.current = setTimeout(() => { timer.current = undefined; if (active.current === drag) setShown(drag); }, 0);
      },
      onDragEnd: () => clear(),
    }),
    /** Props for a row in the chat tree: a drop target when the drag allows it. */
    // dragenter too: Chromium fires it first when the cursor reaches another row (T056-shots), so the light moves at once.
    target: (id: SessionId) => ({
      'data-drop': current && over === `row:${id}` ? 'over' : undefined,
      onDragEnter: (event: DragEvent) => accept(event, `row:${id}`, !!current?.targets.has(id)),
      onDragOver: (event: DragEvent) => accept(event, `row:${id}`, !!current?.targets.has(id)),
      onDrop: (event: DragEvent) => drop(event, id),
    }),
    /** The 「移到最上層」 zone: only while a session with a parent is dragged. */
    top: current?.toTop ? {
      'data-drop': over === 'top' ? 'over' : undefined,
      onDragEnter: (event: DragEvent) => accept(event, 'top', true),
      onDragOver: (event: DragEvent) => accept(event, 'top', true),
      onDrop: (event: DragEvent) => drop(event, null),
    } : undefined,
    /** For the list: leaving it clears the row under the cursor. */
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(null);
    },
  };
}
