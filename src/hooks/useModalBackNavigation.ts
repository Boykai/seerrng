import { useEffect, useRef } from 'react';

const modalHistoryKey = '__seerrModal';
let nextModalId = 0;
const openModals: number[] = [];

/** Give a dismissible screen one browser-history step, without changing its URL. */
export default function useModalBackNavigation(onCancel?: () => void) {
  const id = useRef(0);
  if (id.current === 0) id.current = ++nextModalId;
  const cancel = useRef(onCancel);
  const active = useRef(false);
  cancel.current = onCancel;
  const enabled = Boolean(onCancel);

  useEffect(() => {
    if (!enabled) return;

    const modalId = id.current;
    active.current = true;
    if (window.history.state?.[modalHistoryKey] !== modalId) {
      window.history.pushState(
        { ...window.history.state, [modalHistoryKey]: modalId },
        '',
        window.location.href
      );
    }
    openModals.push(modalId);

    const handleBack = (event: PopStateEvent) => {
      if (
        openModals[openModals.length - 1] === modalId &&
        event.state?.[modalHistoryKey] !== modalId
      ) {
        cancel.current?.();
      }
    };
    window.addEventListener('popstate', handleBack);

    return () => {
      active.current = false;
      window.removeEventListener('popstate', handleBack);
      const index = openModals.lastIndexOf(modalId);
      if (index !== -1) openModals.splice(index, 1);
      // A button/overlay close should consume the same history entry as Back.
      // Deferring also avoids consuming it during React Strict Mode's effect replay.
      queueMicrotask(() => {
        if (
          !active.current &&
          window.history.state?.[modalHistoryKey] === modalId
        ) {
          window.history.back();
        }
      });
    };
  }, [enabled]);
}
