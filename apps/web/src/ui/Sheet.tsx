import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../copy';
import { Icon } from './Icon';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open sheets, oldest first; only the newest handles keys and keeps focus. */
const openSheets: HTMLElement[] = [];

/**
 * Registers an open sheet and makes the app root inert while any sheet is open, so neither
 * focus nor assistive technology can reach the page behind it. Sheets render outside the
 * root, so they stay interactive.
 */
function registerSheet(dialog: HTMLElement): () => void {
  const root = document.getElementById('root');
  openSheets.push(dialog);
  root?.setAttribute('inert', '');
  return () => {
    openSheets.splice(openSheets.lastIndexOf(dialog), 1);
    if (openSheets.length === 0) root?.removeAttribute('inert');
  };
}

function isTopSheet(dialog: HTMLElement): boolean {
  return openSheets[openSheets.length - 1] === dialog;
}

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Hide the visible title (it still labels the dialog). */
  hideTitle?: boolean;
}

/**
 * A modal sheet: slides up from the bottom on compact widths and is a centered dialog on
 * wider ones. Focus moves in on open, is kept inside, and returns to the invoking control on
 * close; Escape closes.
 */
export function Sheet({ title, onClose, children, wide, hideTitle }: SheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hasAttribute('hidden'),
      );
    const focusStart = () => {
      const first = dialog.querySelector('.sheet__body')?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    };
    focusStart();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const unregister = registerSheet(dialog);

    function onKeyDown(event: KeyboardEvent) {
      if (!dialog || !isTopSheet(dialog)) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const active = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const inside = active instanceof Node && active !== dialog && dialog.contains(active);
      if (!inside) {
        // Focus was on the dialog itself or was lost (its control unmounted): re-enter.
        event.preventDefault();
        (event.shiftKey ? lastItem : firstItem).focus();
      } else if (event.shiftKey && active === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    // When the focused control is replaced (a sent form, a finished step), focus would fall to
    // the page; bring it back to the start of the sheet instead.
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (isTopSheet(dialog) && (!active || active === document.body)) focusStart();
    });
    observer.observe(dialog, { childList: true, subtree: true });

    document.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      unregister();
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={wide ? 'sheet sheet--wide' : 'sheet'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <button
          type="button"
          className="sheet__close"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <Icon name="close" />
        </button>
        <h2 id={titleId} className={hideTitle ? 'sr-only' : 'sheet__title'}>
          {title}
        </h2>
        <div className="sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
