import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const activeModalDialogs = new Set<HTMLElement>();
const inertedBackground = new Map<HTMLElement, boolean>();

const refreshInertBackground = (): void => {
  for (const [element, wasInert] of inertedBackground) {
    if (!wasInert) element.removeAttribute("inert");
  }
  inertedBackground.clear();
  if (activeModalDialogs.size === 0) return;

  const protectedElements = new Set<HTMLElement>();
  for (const dialog of activeModalDialogs) {
    let current: HTMLElement | null = dialog;
    while (current) {
      protectedElements.add(current);
      current = current.parentElement;
    }
  }
  for (const dialog of activeModalDialogs) {
    let current: HTMLElement | null = dialog;
    while (current?.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === current || protectedElements.has(sibling) || inertedBackground.has(sibling)) continue;
        inertedBackground.set(sibling, sibling.hasAttribute("inert"));
        sibling.setAttribute("inert", "");
      }
      current = current.parentElement;
    }
  }
};

interface AccessibleDialogProps {
  className: string;
  label: string;
  children: ReactNode;
  modal?: boolean;
  onClose?(): void;
}

export const AccessibleDialog = ({ className, label, children, modal = true, onClose }: AccessibleDialogProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modal && dialog) {
      activeModalDialogs.add(dialog);
      refreshInertBackground();
    }
    dialog?.focus();
    return () => {
      if (modal && dialog) {
        activeModalDialogs.delete(dialog);
        refreshInertBackground();
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [modal]);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !modal) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => element.getAttribute("aria-hidden") !== "true");
    event.preventDefault();
    if (focusable.length === 0) {
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? currentIndex <= 0 ? last : focusable[currentIndex - 1]!
      : currentIndex < 0 || currentIndex === focusable.length - 1 ? first : focusable[currentIndex + 1]!;
    next.focus();
  };

  return (
    <dialog
      open
      ref={dialogRef}
      className={`accessible-dialog ${className}`}
      aria-modal={modal}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {children}
    </dialog>
  );
};
