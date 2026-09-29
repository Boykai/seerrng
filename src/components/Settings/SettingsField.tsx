import SelectionCircle from '@app/components/Common/SelectionCircle';
import { notifySettingsUserChange } from '@app/components/Settings/settingsEvents';
import { Field as FormikField, useField, type FieldAttributes } from 'formik';
import type { ChangeEvent } from 'react';

interface SettingsFieldProps {
  name: string;
  type?: string;
  id?: string;
  disabled?: boolean;
  checked?: boolean;
  label?: string;
  onCheckedChange?: (checked: boolean) => void;
  'data-testid'?: string;
  [key: string]: unknown;
}

const ControlledSettingsCheckboxField = ({
  checked,
  id,
  name,
  disabled,
  label,
  onCheckedChange,
  'data-testid': dataTestId,
}: SettingsFieldProps) => (
  <SelectionCircle
    id={id}
    name={name}
    data-testid={dataTestId}
    label={label}
    selected={checked ?? false}
    disabled={disabled ?? false}
    onClick={() => onCheckedChange?.(!checked)}
  />
);

const FormikSettingsCheckboxField = ({
  id,
  name,
  disabled,
  label,
  'data-testid': dataTestId,
  onChange,
}: SettingsFieldProps) => {
  const [field, , helpers] = useField<boolean>({ name, type: 'checkbox' });

  return (
    <SelectionCircle
      id={id}
      name={name}
      data-testid={dataTestId}
      label={label}
      selected={field.value}
      disabled={disabled ?? false}
      onBlur={() => void helpers.setTouched(true)}
      onClick={() => {
        const checked = !field.value;
        void helpers.setValue(checked);
        notifySettingsUserChange();

        if (typeof onChange === 'function') {
          const checkboxOnChange = onChange as (
            event: ChangeEvent<HTMLInputElement>
          ) => void;
          checkboxOnChange({
            target: { checked, name },
            currentTarget: { checked, name },
          } as ChangeEvent<HTMLInputElement>);
        }
      }}
    />
  );
};

const SettingsField = (props: SettingsFieldProps) =>
  props.type === 'checkbox' ? (
    typeof props.checked === 'boolean' && props.onCheckedChange ? (
      <ControlledSettingsCheckboxField {...props} />
    ) : (
      <FormikSettingsCheckboxField {...props} />
    )
  ) : (
    <FormikField {...(props as FieldAttributes<unknown>)} />
  );

export default SettingsField;
