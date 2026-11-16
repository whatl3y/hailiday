import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import './disclosure.css';

export interface DisclosureProps {
  /** The row's name; it also names the panel's region. */
  label: string;
  /** A quiet one-line summary beside the label (for example the current look). */
  summary?: ReactNode;
  /** Called with the new state each time the row is opened or closed. */
  onToggle?: (open: boolean) => void;
  /** The panel's content is loading: the region is marked busy. */
  busy?: boolean;
  /** Called when keyboard focus enters (true) or leaves (false) the row and its panel. */
  onFocusWithin?: (inside: boolean) => void;
  className?: string;
  children: ReactNode;
}

/**
 * A collapsed row that opens a panel beneath it: a heading holding a button with
 * `aria-expanded` and `aria-controls`, and a region labelled by the row's name. It starts
 * collapsed every time it mounts. The panel's content mounts on the first opening (so it loads
 * nothing until then) and stays mounted while collapsed, keeping what the person entered.
 */
export function Disclosure({
  label,
  summary,
  onToggle,
  busy,
  onFocusWithin,
  className,
  children,
}: DisclosureProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const labelId = `${id}-label`;
  const panelId = `${id}-panel`;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) setOpened(true);
    onToggle?.(next);
  }

  return (
    <div
      className={className ? `disclosure ${className}` : 'disclosure'}
      data-open={open || undefined}
      onFocus={onFocusWithin ? () => onFocusWithin(true) : undefined}
      onBlur={
        onFocusWithin
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onFocusWithin(false);
            }
          : undefined
      }
    >
      <h2 className="disclosure__heading">
        <button
          type="button"
          className="disclosure__toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          <span id={labelId} className="disclosure__label">
            {label}
          </span>
          {summary ? <span className="disclosure__summary">{summary}</span> : null}
          <Icon name="chevronDown" className="disclosure__chevron" />
        </button>
      </h2>
      <div
        id={panelId}
        role="region"
        aria-labelledby={labelId}
        aria-busy={busy || undefined}
        className="disclosure__panel"
        hidden={!open}
      >
        {opened ? children : null}
      </div>
    </div>
  );
}
