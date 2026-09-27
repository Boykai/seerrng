import React, { useMemo } from 'react';
import ReactDOM from 'react-dom';
import type { Config } from 'react-popper-tooltip';
import { usePopperTooltip } from 'react-popper-tooltip';

type TooltipProps = {
  content: React.ReactNode;
  children: React.ReactElement<any>;
  tooltipConfig?: Partial<Config>;
  className?: string;
};

const Tooltip = ({
  children,
  content,
  tooltipConfig,
  className,
}: TooltipProps) => {
  const popperConfig = useMemo(
    () => ({
      followCursor: true,
      offset: [0, 14] as [number, number],
      placement: 'top' as const,
      ...tooltipConfig,
    }),
    [tooltipConfig]
  );
  const { getTooltipProps, setTooltipRef, setTriggerRef, visible } =
    usePopperTooltip(popperConfig);

  const tooltipClassName = useMemo(
    () => ['app-tooltip', className].filter(Boolean).join(' '),
    [className]
  );

  return (
    <>
      {React.cloneElement(children, {
        ref: setTriggerRef,
        'data-app-tooltip-owned': true,
      })}
      {visible &&
        content &&
        ReactDOM.createPortal(
          <div
            ref={setTooltipRef}
            {...getTooltipProps({
              className: tooltipClassName,
            })}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
};

export default Tooltip;
