import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

interface Props {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  /** Error message shown inside the dialog; the dialog stays open so the user sees why the action failed. */
  error?: ReactNode;
  /**
   * If set, the user must type this exact string before the confirm button
   * becomes enabled. Used for irreversible destructive actions like deleting
   * a whole property where a single misclick would be very costly.
   */
  requireText?: string;
  /** Override the placeholder/hint for the require-text input. */
  requireTextHint?: string;
}

/**
 * Accessible confirmation dialog built on the native <dialog> element.
 * Uses showModal() so it traps focus and closes on Escape automatically.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Onayla',
  cancelLabel = 'İptal',
  destructive = false,
  onConfirm,
  onCancel,
  loading,
  error,
  requireText,
  requireTextHint,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
    // Reset the type-to-confirm field when the dialog (re-)opens or closes.
    if (!open) setTyped('');
  }, [open]);

  const requireMatches = !requireText || typed.trim() === requireText.trim();
  const confirmDisabled = loading || !requireMatches;

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="rounded-lg bg-white p-0 shadow-xl backdrop:bg-black/50 dark:bg-stone-900"
    >
      <div className="w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">{title}</h2>
        {description && (
          <div className="mt-2 text-sm text-stone-700 dark:text-stone-300">{description}</div>
        )}
        {requireText && (
          <div className="mt-4">
            <label className="block text-xs text-stone-700 dark:text-stone-300">
              {requireTextHint ?? (
                <>
                  Onaylamak için{' '}
                  <code className="rounded bg-stone-100 px-1 font-mono text-stone-900 dark:bg-stone-800 dark:text-stone-100">
                    {requireText}
                  </code>{' '}
                  yazın
                </>
              )}
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500/30 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
            />
          </div>
        )}
        {error && (
          <p className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
