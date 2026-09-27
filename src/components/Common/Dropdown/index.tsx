import { withProperties } from '@app/utils/typeHelpers';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { ChevronDownIcon } from '@heroicons/react/24/solid';
import {
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from 'react';

type DropdownButtonType =
  'primary' | 'ghost' | 'success' | 'detailRequest' | 'playback';

interface DropdownItemProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  buttonType?: DropdownButtonType;
}

const DropdownItem = ({
  children,
  buttonType = 'primary',
  ...props
}: DropdownItemProps) => {
  return (
    <MenuItem>
      <a
        className="app-dropdown-item"
        data-dropdown-type={buttonType}
        {...props}
      >
        {children}
      </a>
    </MenuItem>
  );
};

type DropdownItemsProps = HTMLAttributes<HTMLDivElement>;

const DropdownItems = ({
  children,
  className,
  ...props
}: DropdownItemsProps) => {
  return (
    <MenuItems
      transition
      className={[
        'app-dropdown-menu absolute top-full right-0 z-40 mt-2 -mr-1 w-56 origin-top-right transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0',
        className,
      ].join(' ')}
      {...props}
    >
      <div>{children}</div>
    </MenuItems>
  );
};

interface DropdownProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  text: React.ReactNode;
  dropdownIcon?: React.ReactNode;
  buttonType?: DropdownButtonType;
  buttonSize?: 'default' | 'md' | 'sm';
  disabledReason?: string;
}

const Dropdown = ({
  text,
  children,
  dropdownIcon,
  className,
  buttonType = 'primary',
  buttonSize = 'md',
  disabledReason,
  title,
  ...props
}: DropdownProps) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const buttonTypeClassNames: Record<DropdownButtonType, string> = {
    primary: 'app-button-primary',
    ghost: 'app-button-ghost',
    success: 'app-button-success',
    detailRequest: 'app-button-detail-request',
    playback: 'app-button-playback playback-dropdown-trigger',
  };

  return (
    <Menu as="div" className="relative z-10 inline-flex">
      <MenuButton
        type="button"
        className={[
          'app-button',
          buttonTypeClassNames[buttonType],
          buttonSize === 'sm' ? 'button-sm' : 'button-md',
          className,
        ].join(' ')}
        ref={buttonRef}
        disabled={!children}
        data-button-help={title}
        data-disabled-reason={!children ? disabledReason : undefined}
        {...props}
      >
        <span className="inline-flex min-w-0 items-center">{text}</span>
        {children && (dropdownIcon ? dropdownIcon : <ChevronDownIcon />)}
      </MenuButton>
      {children && <DropdownItems>{children}</DropdownItems>}
    </Menu>
  );
};
export default withProperties(Dropdown, {
  Item: DropdownItem,
  Items: DropdownItems,
});
