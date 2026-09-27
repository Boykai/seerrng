import { CheckIcon } from '@heroicons/react/24/solid';
import type { FocusEventHandler, KeyboardEvent, MouseEvent } from 'react';

export const selectFromRow = (
  event: MouseEvent<HTMLElement>,
  onSelect: () => void
) => {
  const target = event.target;
  const interactiveTarget =
    target instanceof Element
      ? target.closest(
          'a, button, input, select, textarea, [role="button"], [data-no-row-select]'
        )
      : null;
  if (interactiveTarget && interactiveTarget !== event.currentTarget) {
    return;
  }
  onSelect();
};

export const selectFromRowKey = (
  event: KeyboardEvent<HTMLElement>,
  onSelect: () => void
) => {
  if (
    event.target !== event.currentTarget ||
    (event.key !== 'Enter' && event.key !== ' ')
  ) {
    return;
  }
  event.preventDefault();
  onSelect();
};

interface SelectionCircleProps {
  selected: boolean;
  partial?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  'data-testid'?: string;
  label?: string;
  onBlur?: FocusEventHandler<HTMLButtonElement>;
  onClick: () => void;
}

const SelectionCircle = ({
  selected,
  partial = false,
  disabled = false,
  id,
  name,
  'data-testid': dataTestId,
  label,
  onBlur,
  onClick,
}: SelectionCircleProps) => (
  <button
    type="button"
    id={id}
    name={name}
    data-testid={dataTestId}
    disabled={disabled}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    onBlur={onBlur}
    aria-label={label}
    aria-pressed={partial ? 'mixed' : selected}
    data-partial={partial || undefined}
    className="selection-circle"
  >
    <CheckIcon className="selection-circle-icon" aria-hidden="true" />
  </button>
);

export default SelectionCircle;
