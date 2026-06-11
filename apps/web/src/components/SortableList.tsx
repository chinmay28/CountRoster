import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

/** Props to spread onto a drag handle so it can start a drag. */
export interface SortableHandleProps {
  onPointerDown: (e: ReactPointerEvent) => void;
}

/**
 * A vertical list whose items can be reordered by dragging a handle. Works with
 * both mouse and touch (Pointer Events + pointer capture), so it's usable on the
 * mobile PWA without a drag-and-drop dependency.
 *
 * The list owns the `<ul>`/`<li>` wrappers and live-previews the new order while
 * dragging; `onReorder` is called once, on drop, with the final id order — only
 * if it actually changed. `renderItem` supplies each row's contents and receives
 * the handle props to attach to whatever element should initiate the drag.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  className,
  itemClassName,
  renderItem,
}: {
  items: T[];
  onReorder: (orderedIds: string[]) => void;
  className?: string;
  itemClassName?: string;
  renderItem: (
    item: T,
    handleProps: SortableHandleProps,
    dragging: boolean,
  ) => ReactNode;
}) {
  const [order, setOrder] = useState<T[]>(items);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;
  const els = useRef(new Map<string, HTMLLIElement>());

  // Re-sync local order when the source list changes (add/remove/external
  // reorder). A drag never adds or removes ids, so `itemsKey` is stable for the
  // duration of a drag and this won't fight the live preview.
  const itemsKey = items.map((i) => i.id).join(',');
  useEffect(() => {
    setOrder(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  function onHandleDown(id: string, e: ReactPointerEvent) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingId(id);
  }

  function onMove(e: ReactPointerEvent) {
    if (draggingId == null) return;
    const y = e.clientY;
    const current = orderRef.current;
    const without = current.filter((it) => it.id !== draggingId);
    let insertAt = without.length;
    for (let i = 0; i < without.length; i++) {
      const el = els.current.get(without[i]!.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        insertAt = i;
        break;
      }
    }
    const dragged = current.find((it) => it.id === draggingId);
    if (!dragged) return;
    without.splice(insertAt, 0, dragged);
    if (without.some((it, i) => it.id !== current[i]?.id)) setOrder(without);
  }

  function onUp() {
    if (draggingId == null) return;
    // Pointer capture is released implicitly on pointerup/cancel.
    const finalOrder = orderRef.current;
    setDraggingId(null);
    if (finalOrder.some((it, i) => it.id !== items[i]?.id)) {
      onReorder(finalOrder.map((it) => it.id));
    }
  }

  return (
    <ul
      className={className}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {order.map((item) => {
        const dragging = item.id === draggingId;
        return (
          <li
            key={item.id}
            ref={(el) => {
              if (el) els.current.set(item.id, el);
              else els.current.delete(item.id);
            }}
            className={[itemClassName, dragging ? 'is-dragging' : '']
              .filter(Boolean)
              .join(' ')}
          >
            {renderItem(
              item,
              { onPointerDown: (e) => onHandleDown(item.id, e) },
              dragging,
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A standard grip button to use as a drag handle. */
export function DragHandle({
  handleProps,
  label,
}: {
  handleProps: SortableHandleProps;
  label: string;
}) {
  return (
    <button
      type="button"
      className="drag-handle"
      aria-label={label}
      title="Drag to reorder"
      {...handleProps}
    >
      ⠿
    </button>
  );
}
