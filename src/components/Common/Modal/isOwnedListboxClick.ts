// Anchored listboxes render outside the dialog to avoid clipping. Their label
// still belongs to the dialog, so choosing an option is not a backdrop click.
export const isOwnedListboxClick = (
  modal: HTMLElement | null,
  target: EventTarget | null
): boolean => {
  if (!modal || !(target instanceof Element)) return false;
  const listbox = target.closest('[role="listbox"]');
  const labelIds = listbox?.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
  return labelIds.some((id) =>
    modal.contains(modal.ownerDocument.getElementById(id))
  );
};
