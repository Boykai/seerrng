import defineMessages from '@app/utils/defineMessages';
import type { IntlShape } from 'react-intl';

export const buttonHelpMessages = defineMessages(
  'components.Common.ButtonHelp',
  {
    unavailable: 'This action is unavailable in the current state.',
    save: 'Save your changes.',
    cancel: 'Cancel the current action.',
    close: 'Close this window.',
    edit: 'Edit the selected item.',
    delete: 'Delete the selected item.',
    remove: 'Remove the selected item.',
    refresh: 'Reload the latest information.',
    retry: 'Try the failed action again.',
    next: 'Go to the next page or step.',
    previous: 'Go to the previous page or step.',
    copy: 'Copy this value to your clipboard.',
    test: 'Test the configured connection or integration.',
    search: 'Search using the information you entered.',
    request: 'Choose the options for requesting this media.',
    requestFormat: 'Request the {format} version of this media.',
    play: 'Open this media in {service} so you can play it there.',
    playOnDevice:
      'Choose an active, authorized device and start playing the selected media on it.',
    manage:
      'Manage requests, linked services, blocklist status, and issues for this media.',
    report:
      'Report a playback, audio, subtitle, or other issue with this media.',
    associations: 'View related media and their connections.',
    settings: 'Open settings for this account or service.',
    profile: 'Open this user profile.',
    trailer: 'Open the trailer for this media.',
    show: 'Show {label}.',
    hide: 'Hide {label}.',
    options: 'Show the available actions.',
    select: 'Select this item.',
    deselect: 'Deselect this item.',
  }
);

// Filters and selectors intentionally keep their existing behavior. An explicit
// opt-out is available for controls added outside the shared filter components.
const excluded =
  '[data-button-help="off"], [data-button-help-exclude], .app-filter-button, .app-filter-select-trigger, .app-filter-select-menu, .discover-filter-control, .react-select-container, [role="listbox"], [role="option"], [role="combobox"]';
export const findHelpButton = (
  target: EventTarget | null
): HTMLElement | null => {
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLElement>(
    'button, [role="button"], a.app-button, a.compact-control'
  );
  if (
    !button ||
    button.closest(excluded) ||
    button.closest('[data-app-tooltip-owned]')
  )
    return null;
  return button;
};

const commonActions: Record<string, keyof typeof buttonHelpMessages> = {
  save: 'save',
  'save changes': 'save',
  cancel: 'cancel',
  close: 'close',
  done: 'close',
  edit: 'edit',
  delete: 'delete',
  remove: 'remove',
  refresh: 'refresh',
  retry: 'retry',
  next: 'next',
  previous: 'previous',
  back: 'previous',
  copy: 'copy',
  test: 'test',
  search: 'search',
  request: 'request',
  'manage movie': 'manage',
  'manage series': 'manage',
  'manage music': 'manage',
  'manage book': 'manage',
  'report an issue': 'report',
  associations: 'associations',
  settings: 'settings',
  profile: 'profile',
  'watch trailer': 'trailer',
  expand: 'options',
  'open options': 'options',
};

export const getButtonLabelText = (element: Element | null): string => {
  if (!element) return '';
  const copy = element.cloneNode(true) as Element;
  copy
    .querySelectorAll('svg, style, script, [aria-hidden="true"], [hidden]')
    .forEach((node) => node.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
};

export const getButtonHelp = (button: HTMLElement, intl: IntlShape): string => {
  const disabled =
    button.matches(':disabled') ||
    button.getAttribute('aria-disabled') === 'true';
  const reason = button.getAttribute('data-disabled-reason');
  if (disabled && reason) return reason;
  const explicit =
    button.getAttribute('data-button-help') || button.getAttribute('title');
  if (explicit) return explicit;
  if (disabled) return intl.formatMessage(buttonHelpMessages.unavailable);
  const labelledBy = button
    .getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map((id) => getButtonLabelText(button.ownerDocument.getElementById(id)))
    .join(' ');
  const label = (
    button.getAttribute('aria-label') ||
    labelledBy ||
    getButtonLabelText(button) ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) return '';
  if (label.toLowerCase() === 'play on device')
    return intl.formatMessage(buttonHelpMessages.playOnDevice);
  const playService = /^play on (.+)$/i.exec(label)?.[1];
  if (playService)
    return intl.formatMessage(buttonHelpMessages.play, {
      service: playService,
    });
  if (button.matches('.format-request-option'))
    return intl.formatMessage(buttonHelpMessages.requestFormat, {
      format: label,
    });
  if (button.getAttribute('role') === 'checkbox')
    return intl.formatMessage(
      button.getAttribute('aria-checked') === 'true'
        ? buttonHelpMessages.deselect
        : buttonHelpMessages.select
    );
  const expanded = button.getAttribute('aria-expanded');
  if (expanded !== null && !button.hasAttribute('aria-haspopup')) {
    return intl.formatMessage(
      expanded === 'true' ? buttonHelpMessages.hide : buttonHelpMessages.show,
      { label: label.replace(/^view\s+/i, '') }
    );
  }
  const key = commonActions[label.toLowerCase()];
  // Unknown/dynamic actions retain their existing localized accessible label;
  // never invent destructive effects or infer behavior from an icon.
  return key ? intl.formatMessage(buttonHelpMessages[key]) : label;
};
