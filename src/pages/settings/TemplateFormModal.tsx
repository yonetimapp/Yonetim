import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createTemplate,
  updateTemplate,
  TEMPLATE_VARIABLES,
  type MessageTemplate,
} from '@/lib/queries/templates';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';

interface Props {
  /** Pass an existing template to edit; omit for create. */
  template?: MessageTemplate | null;
  onClose: () => void;
  onSaved: (template: MessageTemplate) => void;
}

export function TemplateFormModal({ template, onClose, onSaved }: Props) {
  const isEdit = Boolean(template);
  const [name, setName] = useState(template?.name ?? '');
  const [content, setContent] = useState(template?.content ?? '');
  const [isDefault, setIsDefault] = useState(template?.is_default ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Şablon adı zorunludur.');
      return;
    }
    if (!content.trim()) {
      setError('Şablon içeriği boş olamaz.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        content: content.trim(),
        is_default: isDefault,
      };
      const saved =
        isEdit && template
          ? await updateTemplate(template.id, payload)
          : await createTemplate(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  /** Insert a {variable} token at the cursor in the content textarea. */
  const insertVariable = (variable: string) => {
    const token = `{${variable}}`;
    setContent((prev) => prev + (prev.endsWith(' ') || prev === '' ? '' : ' ') + token);
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
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            {isEdit ? 'Şablon Düzenle' : 'Yeni Şablon'}
          </h2>
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

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Input
            ref={nameRef}
            label="Şablon Adı"
            name="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn: Karşılama Mesajı"
            maxLength={80}
          />

          <div>
            <label
              htmlFor="content"
              className="block text-sm font-medium text-stone-700 dark:text-stone-300"
            >
              İçerik<span className="ml-0.5 text-red-500">*</span>
            </label>
            <textarea
              id="content"
              name="content"
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              maxLength={2000}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder:text-stone-500"
            />
            <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
              Değişken eklemek için aşağıdaki etiketlere tıklayın.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVariable(v)}
                  className="rounded bg-stone-200 px-2 py-0.5 text-xs font-mono text-stone-700 hover:bg-stone-300 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600"
                >
                  {`{${v}}`}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
              İngilizce karşılıklar da çalışır (örn.{' '}
              <code className="font-mono">{'{checkin}'}</code>,{' '}
              <code className="font-mono">{'{checkout}'}</code>,{' '}
              <code className="font-mono">{'{property}'}</code>,{' '}
              <code className="font-mono">{'{unit}'}</code>,{' '}
              <code className="font-mono">{'{guest}'}</code>,{' '}
              <code className="font-mono">{'{catalog}'}</code>).
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-stone-300">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-stone-300 text-sky-600 focus:ring-sky-500"
            />
            Varsayılan şablon (WhatsApp gönderirken önce bu seçilir)
          </label>

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              İptal
            </Button>
            <Button type="submit" loading={saving}>
              {isEdit ? 'Kaydet' : 'Oluştur'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
