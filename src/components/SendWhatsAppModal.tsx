import { useEffect, useMemo, useState } from 'react';
import {
  listTemplates,
  substituteVariables,
  type MessageTemplate,
  type TemplateVariable,
} from '@/lib/queries/templates';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { toWhatsAppPhone, whatsAppShareUrl, whatsAppUrl } from '@/lib/utils';

interface Props {
  /** Display name shown in the heading. */
  recipientName: string;
  /** Raw phone string (any format). Modal handles normalization. */
  recipientPhone: string | null | undefined;
  /** Map of template variables → substituted values. Caller fills what's available. */
  variables: Partial<Record<TemplateVariable, string>>;
  onClose: () => void;
}

export function SendWhatsAppModal({
  recipientName,
  recipientPhone,
  variables,
  onClose,
}: Props) {
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'ok' | 'fail'>('idle');

  const normalizedPhone = useMemo(() => toWhatsAppPhone(recipientPhone), [recipientPhone]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  useEffect(() => {
    listTemplates()
      .then((ts) => {
        setTemplates(ts);
        // Auto-select the default template if there is one, else first available.
        const initial = ts.find((t) => t.is_default) ?? ts[0];
        if (initial) {
          setSelectedId(initial.id);
          setDraft(substituteVariables(initial.content, variables));
        }
      })
      .catch((e) => setError(e?.message ?? 'Şablonlar yüklenemedi'));
    // We intentionally don't depend on `variables` — first-load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePickTemplate = (id: string) => {
    setSelectedId(id);
    const t = templates?.find((t) => t.id === id);
    if (t) setDraft(substituteVariables(t.content, variables));
  };

  const hasDraft = draft.trim().length > 0;
  const canSend = Boolean(normalizedPhone && hasDraft);

  const handleSend = () => {
    if (!canSend || !normalizedPhone) return;
    const url = whatsAppUrl(normalizedPhone, draft);
    window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  const handleSendNoPhone = () => {
    if (!hasDraft) return;
    window.open(whatsAppShareUrl(draft), '_blank', 'noopener,noreferrer');
    onClose();
  };

  const handleCopy = async () => {
    if (!hasDraft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopyStatus('ok');
      window.setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('fail');
      window.setTimeout(() => setCopyStatus('idle'), 3000);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-16"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-lg">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              WhatsApp Gönder
            </h2>
            <p className="mt-0.5 text-sm text-stone-600 dark:text-stone-300">
              Alıcı: <strong>{recipientName}</strong>{' '}
              {normalizedPhone ? (
                <span className="font-mono text-xs">+{normalizedPhone}</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">
                  (telefon yok — kopyala veya telefonsuz aç)
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700"
            aria-label="Kapat"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          {!templates && !error && (
            <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
          )}

          {templates && templates.length === 0 && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              Henüz şablon yok. Ayarlar → Şablonlar'dan bir şablon ekleyebilirsiniz.
            </p>
          )}

          {templates && templates.length > 0 && (
            <>
              <Select
                label="Şablon"
                name="template"
                value={selectedId}
                onChange={handlePickTemplate}
                options={templates.map((t) => ({
                  value: t.id,
                  label: t.is_default ? `${t.name} (Varsayılan)` : t.name,
                }))}
                placeholder="Şablon seçin"
              />

              <div>
                <label
                  htmlFor="message-draft"
                  className="block text-sm font-medium text-stone-700 dark:text-stone-300"
                >
                  Mesaj
                </label>
                <textarea
                  id="message-draft"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={8}
                  maxLength={2000}
                  className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100"
                />
                <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
                  Göndermeden önce mesajı düzenleyebilirsiniz.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            İptal
          </Button>
          <Button variant="secondary" onClick={handleCopy} disabled={!hasDraft}>
            {copyStatus === 'ok'
              ? 'Kopyalandı ✓'
              : copyStatus === 'fail'
                ? 'Kopyalanamadı'
                : 'Mesajı Kopyala'}
          </Button>
          <Button variant="secondary" onClick={handleSendNoPhone} disabled={!hasDraft}>
            <WhatsAppIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
            Telefonsuz Aç
          </Button>
          <Button onClick={handleSend} disabled={!canSend}>
            <WhatsAppIcon className="h-4 w-4" />
            WhatsApp'ta Aç
          </Button>
        </div>
      </Card>
    </div>
  );
}
