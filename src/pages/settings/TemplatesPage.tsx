import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { can, baseRole } from '@/lib/rbac';
import {
  listTemplates,
  deleteTemplate,
  type MessageTemplate,
} from '@/lib/queries/templates';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TemplateFormModal } from './TemplateFormModal';

export function TemplatesPage() {
  const { profile } = useAuth();
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<MessageTemplate | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [toDelete, setToDelete] = useState<MessageTemplate | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canWrite =
    Boolean(profile && can(profile.role, 'admin:*')) ||
    baseRole(profile?.role) === 'PROPERTY_MANAGER';

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch((e) => setError(e?.message ?? 'Şablonlar yüklenemedi'));
  }, []);

  const handleDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTemplate(toDelete.id);
      setTemplates((prev) => prev?.filter((t) => t.id !== toDelete.id) ?? prev);
      setToDelete(null);
      setDeleting(false);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Silme başarısız');
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            WhatsApp Şablonları
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Misafire WhatsApp üzerinden gönderilecek mesaj şablonları
          </p>
        </div>
        {canWrite && (
          <Button
            className="shrink-0"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + Yeni Şablon
          </Button>
        )}
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!templates && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {templates && templates.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Henüz şablon eklenmemiş.
          </p>
        </Card>
      )}

      {templates &&
        templates.map((t) => (
          <Card key={t.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
                    {t.name}
                  </h2>
                  {t.is_default && (
                    <span className="rounded bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                      Varsayılan
                    </span>
                  )}
                </div>
              </div>
              {canWrite && (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditing(t);
                      setShowForm(true);
                    }}
                  >
                    Düzenle
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setDeleteError(null);
                      setToDelete(t);
                    }}
                  >
                    Sil
                  </Button>
                </div>
              )}
            </div>
            <pre className="whitespace-pre-wrap rounded bg-stone-50 px-3 py-2 font-sans text-sm text-stone-800 dark:bg-stone-800/60 dark:text-stone-200">
              {t.content}
            </pre>
          </Card>
        ))}

      {showForm && (
        <TemplateFormModal
          template={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={(saved) => {
            setTemplates((prev) => {
              if (!prev) return [saved];
              const idx = prev.findIndex((t) => t.id === saved.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = saved;
                return next;
              }
              return [saved, ...prev];
            });
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={toDelete ? `"${toDelete.name}" şablonu silinsin mi?` : ''}
        description="Şablon Çöp Kutusu'na taşınır ve oradan geri yüklenebilir."
        confirmLabel="Sil"
        destructive
        loading={deleting}
        error={deleteError}
        onConfirm={handleDelete}
        onCancel={() => {
          setToDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
