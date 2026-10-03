import defineMessages from '@app/utils/defineMessages';
import {
  insertDisclosureRole,
  type SeriesDisclosureRole,
} from '@server/utils/detailDisclosureOrder';
import {
  Children,
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';
import type { DetailDisclosureButtonProps } from './DetailDisclosureButton';

export const DISCLOSURE_DRAG_HOLD_MS = 1000;
const messages = defineMessages('components.MediaDetails.DisclosureOrder', {
  instructions:
    'Hold a button for one second to move it. Or use Shift + Alt + Left or Right Arrow to reorder. Press Escape to cancel.',
  ready: '{label} is ready to move. Drag it between the other buttons.',
  moved: '{label} moved to position {position}.',
  failed:
    'Your button order could not be saved. Your previous order has been restored. Please try again.',
});
type Item = ReactElement<DetailDisclosureButtonProps>;
type Anchor = { role: SeriesDisclosureRole; bounds: DOMRect };
type Gesture = {
  role: SeriesDisclosureRole;
  pointerId: number;
  x: number;
  y: number;
  ready: boolean;
  moved: boolean;
  button: HTMLButtonElement;
  row: HTMLElement;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  original: SeriesDisclosureRole[];
  draft: SeriesDisclosureRole[];
  anchors: Anchor[];
  snapshot: HTMLElement;
  commit: (next: SeriesDisclosureRole[]) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type Ghost = {
  role: SeriesDisclosureRole;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const OrderedDisclosurePanels = ({
  order,
  children,
}: {
  order: readonly SeriesDisclosureRole[];
  children: ReactNode;
}) => {
  const panels = Children.toArray(children) as ReactElement[];
  // Only committed preference order moves panels; drafts affect the button row alone.
  return (
    <>
      {order.map((role) =>
        panels.find((panel) => String(panel.key).endsWith('$' + role))
      )}
    </>
  );
};

const ReorderableDisclosureRow = ({
  order,
  onOrderChange,
  children,
  leading,
  distributed = false,
  disabled = false,
}: {
  order: readonly SeriesDisclosureRole[];
  onOrderChange: (order: SeriesDisclosureRole[]) => Promise<void>;
  children: (Item | false | null)[];
  leading?: ReactNode;
  distributed?: boolean;
  disabled?: boolean;
}) => {
  const intl = useIntl();
  const descriptionId = useId();
  const gesture = useRef<Gesture | undefined>(undefined);
  const suppressClick = useRef<SeriesDisclosureRole | undefined>(undefined);
  const [active, setActive] = useState<{
    role: SeriesDisclosureRole;
    state: 'ready' | 'dragging';
  }>();
  const [draft, setDraft] = useState<SeriesDisclosureRole[]>();
  const [ghost, setGhost] = useState<Ghost>();
  const ghostContainer = useRef<HTMLDivElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const items = new Map(
    children
      .filter((child): child is Item => Boolean(child))
      .map((child) => [String(child.key), child])
  );
  const ghostRole = ghost?.role;
  useLayoutEffect(() => {
    const snapshot = gesture.current?.snapshot;
    if (ghostRole && snapshot)
      ghostContainer.current?.replaceChildren(snapshot);
  }, [ghostRole]);

  const cancel = useCallback(() => {
    const current = gesture.current;
    gesture.current = undefined;
    clearTimeout(current?.timer);
    if (current?.row.hasPointerCapture?.(current.pointerId))
      current.row.releasePointerCapture(current.pointerId);
    setActive(undefined);
    setDraft(undefined);
    setGhost(undefined);
  }, []);
  const placementAt = useCallback((current: Gesture, x: number, y: number) => {
    const pointed = document.elementFromPoint(x, y);
    if (
      !pointed ||
      pointed.closest('.media-detail-disclosure-row') !== current.row
    )
      return undefined;
    // Freeze geometry before reflow. Siblings moving under a stationary pointer
    // cannot oscillate the insertion slot back and forth.
    const anchors = current.anchors.filter(
      (anchor) => anchor.role !== current.role
    );
    const target = [...anchors].sort((a, b) => {
      const distance = (anchor: Anchor) =>
        Math.hypot(
          x - (anchor.bounds.left + anchor.bounds.width / 2),
          y - (anchor.bounds.top + anchor.bounds.height / 2)
        );
      return distance(a) - distance(b);
    })[0];
    if (!target) return [...current.original];
    return insertDisclosureRole(
      current.original,
      current.role,
      target.role,
      x > target.bounds.left + target.bounds.width / 2
    );
  }, []);
  const movePointer = useCallback(
    (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.ready) {
        if (
          Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8
        )
          cancel();
        return;
      }
      if (
        event.clientX === current.x &&
        event.clientY === current.y &&
        !current.moved
      )
        return;
      event.preventDefault();
      current.moved = true;
      setActive({ role: current.role, state: 'dragging' });
      setGhost({
        role: current.role,
        x: event.clientX - current.offsetX,
        y: event.clientY - current.offsetY,
        width: current.width,
        height: current.height,
      });
      const next = placementAt(current, event.clientX, event.clientY);
      current.draft = next ?? [...current.original];
      setDraft(current.draft);
    },
    [cancel, placementAt]
  );
  const finishPointer = useCallback(
    (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      suppressClick.current = current.ready ? current.role : undefined;
      // Revalidate release coordinates; never commit a stale last-hover target.
      const next =
        current.ready && current.moved
          ? placementAt(current, event.clientX, event.clientY)
          : undefined;
      cancel();
      if (next) current.commit(next);
    },
    [cancel, placementAt]
  );
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) {
        suppressClick.current = gesture.current.ready
          ? gesture.current.role
          : undefined;
        cancel();
      }
    };
    const abort = (event: Event) => {
      if (
        event.type === 'pointercancel' &&
        (event as PointerEvent).pointerId !== gesture.current?.pointerId
      )
        return;
      if (gesture.current?.ready) suppressClick.current = gesture.current.role;
      cancel();
    };
    const lostCapture = (event: PointerEvent) => {
      const current = gesture.current;
      if (
        current &&
        event.pointerId === current.pointerId &&
        event.target === current.row
      )
        abort(event);
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', abort);
    window.addEventListener('pointermove', movePointer, { passive: false });
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', abort);
    window.addEventListener('lostpointercapture', lostCapture);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('blur', abort);
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', abort);
      window.removeEventListener('lostpointercapture', lostCapture);
      cancel();
    };
  }, [cancel, finishPointer, movePointer]);
  useEffect(() => {
    cancel();
  }, [cancel, disabled, order]);

  const save = async (
    next: SeriesDisclosureRole[],
    role: SeriesDisclosureRole
  ) => {
    if (next.every((item, index) => item === order[index])) return;
    setSaving(true);
    try {
      await onOrderChange(next);
      setAnnouncement(
        intl.formatMessage(messages.moved, {
          label: items.get(role)?.props.label,
          position: next.indexOf(role) + 1,
        })
      );
    } catch {
      setAnnouncement(intl.formatMessage(messages.failed));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="media-detail-disclosure-row"
      data-disclosure-layout={distributed ? 'distributed' : undefined}
      aria-busy={saving}
    >
      {leading}
      {(draft ?? order).map((role) => {
        const child = items.get(role);
        if (!child) return null;
        return cloneElement(child, {
          reorder: {
            role,
            descriptionId,
            state: active?.role === role ? active.state : undefined,
            handlers: {
              onPointerDown: (event) => {
                suppressClick.current = undefined;
                if (
                  disabled ||
                  saving ||
                  event.button !== 0 ||
                  !event.isPrimary ||
                  event.pointerType !== 'mouse'
                )
                  return;
                cancel();
                const row = event.currentTarget.closest<HTMLElement>(
                  '.media-detail-disclosure-row'
                );
                const control = event.currentTarget.closest<HTMLElement>(
                  '[data-disclosure-role]'
                );
                if (!row || !control) return;
                const bounds = control.getBoundingClientRect();
                // cloneNode copies rendered artwork/markup, never React/native
                // listeners. Remove identifiers and make every copied focus stop inert.
                const snapshot = control.cloneNode(true) as HTMLElement;
                for (const element of [
                  snapshot,
                  ...snapshot.querySelectorAll<HTMLElement>('*'),
                ]) {
                  for (const attribute of [
                    'id',
                    'aria-controls',
                    'aria-describedby',
                    'data-disclosure-role',
                    'data-reorder-state',
                    'data-reorder-insertion',
                  ])
                    element.removeAttribute(attribute);
                  if (
                    element.matches('button,a,input,select,textarea,[tabindex]')
                  )
                    element.setAttribute('tabindex', '-1');
                }
                const current: Gesture = {
                  role,
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  ready: false,
                  moved: false,
                  button: event.currentTarget,
                  row,
                  width: bounds.width,
                  height: bounds.height,
                  offsetX: event.clientX - bounds.left,
                  offsetY: event.clientY - bounds.top,
                  original: [...order],
                  draft: [...order],
                  snapshot,
                  anchors: [
                    ...row.querySelectorAll<HTMLElement>(
                      '[data-disclosure-role]'
                    ),
                  ].map((element) => ({
                    role: element.dataset
                      .disclosureRole as SeriesDisclosureRole,
                    bounds: element.getBoundingClientRect(),
                  })),
                  commit: (next) => {
                    void save(next, role);
                  },
                };
                gesture.current = current;
                // Capture only after hold, on the stable row rather than a moving
                // control. Quick clicks retain their native button click target.
                current.timer = setTimeout(() => {
                  if (gesture.current !== current) return;
                  current.ready = true;
                  row.setPointerCapture?.(current.pointerId);
                  setActive({ role, state: 'ready' });
                  setAnnouncement(
                    intl.formatMessage(messages.ready, {
                      label: child.props.label,
                    })
                  );
                }, DISCLOSURE_DRAG_HOLD_MS);
              },
              onClickCapture: (event) => {
                if (suppressClick.current === role) {
                  event.preventDefault();
                  event.stopPropagation();
                  suppressClick.current = undefined;
                }
              },
              onKeyDown: (event) => {
                if (
                  disabled ||
                  saving ||
                  !event.shiftKey ||
                  !event.altKey ||
                  !['ArrowLeft', 'ArrowRight'].includes(event.key)
                )
                  return;
                event.preventDefault();
                cancel();
                const index = order.indexOf(role),
                  nextIndex = index + (event.key === 'ArrowLeft' ? -1 : 1);
                if (nextIndex >= 0 && nextIndex < order.length)
                  void save(
                    insertDisclosureRole(
                      order,
                      role,
                      order[nextIndex],
                      event.key === 'ArrowRight'
                    ),
                    role
                  );
              },
            },
          },
        });
      })}
      {ghost &&
        createPortal(
          <div
            ref={ghostContainer}
            className="disclosure-drag-ghost"
            aria-hidden="true"
            inert
            style={
              {
                '--disclosure-drag-x': ghost.x + 'px',
                '--disclosure-drag-y': ghost.y + 'px',
                '--disclosure-drag-width': ghost.width + 'px',
                '--disclosure-drag-height': ghost.height + 'px',
              } as CSSProperties
            }
          />,
          document.body
        )}
      <span id={descriptionId} className="disclosure-order-announcement">
        {intl.formatMessage(messages.instructions)}
      </span>
      <span
        className="disclosure-order-announcement"
        role="status"
        aria-live="polite"
      >
        {announcement}
      </span>
    </div>
  );
};
export default ReorderableDisclosureRow;
