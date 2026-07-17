import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  listIssuesForUnit,
  createIssue,
  updateIssueStatus,
  deleteIssue,
  type HousekeepingIssue,
  type IssueStatus,
} from '@/lib/queries/housekeepingIssues';
import { uploadIssuePhoto, issuePhotoUrl, ISSUE_PHOTO_MAX } from '@/lib/photos';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cn } from '@/lib/utils';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';

/** A sorun carries at most one photo — DB CHECK mirrors this (migration 128). */
const MAX_PHOTOS = ISSUE_PHOTO_MAX;

const STATUS_LABELS: Record<IssueStatus, string> = {
  OPEN: 'Açık',
  IN_PROGRESS: 'İşlemde',
  RESOLVED: 'Çözüldü',
};

const STATUS_BADGE: Record<IssueStatus, string> = {
  OPEN: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  IN_PROGRESS: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  RESOLVED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
};

interface Props {
  unitId: string;
  unitName: string;
  propertyId: string;
  reportedByUserId: string;
  canWrite: boolean;
  /** Gate destructive actions (delete). Pass true only for SUPER_ADMIN. */
  canDelete?: boolean;
  onClose: () => void;
  /** Called whenever the open-issue count for this unit may have changed. */
  onChange: () => void;
}

export function IssuesModal({
  unitId,
  unitName,
  propertyId,
  reportedByUserId,
  canWrite,
  canDelete = false,
  onClose,
  onChange,
}: Props) {
  const [issues, setIssues] = useState<HousekeepingIssue[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());

  // Create form state
  const [description, setDescription] = useState('');
  const [uploadedPaths, setUploadedPaths] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Per-row resolve state
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Delete confirm flow (SUPER_ADMIN only)
  const [toDelete, setToDelete] = useState<HousekeepingIssue | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  useEffect(() => {
    setLoadError(null);
    listIssuesForUnit(unitId)
      .then(setIssues)
      .catch((e) => setLoadError(e?.message ?? 'Sorunlar yüklenemedi'));
    loadStaffDirectory().then(setStaffMap).catch(() => {});
  }, [unitId]);

  const handleFilesPicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // reset so the same file can be reselected
    if (files.length === 0) return;

    const remainingSlots = MAX_PHOTOS - uploadedPaths.length;
    if (remainingSlots <= 0) {
      setCreateError(`En fazla ${MAX_PHOTOS} fotoğraf yükleyebilirsiniz.`);
      return;
    }

    setCreateError(null);
    setUploading(true);
    try {
      // Cap to remaining slots; upload sequentially so one failure doesn't
      // strand orphan uploads we don't track.
      const toUpload = files.slice(0, remainingSlots);
      const newPaths: string[] = [];
      for (const f of toUpload) {
        const path = await uploadIssuePhoto(f);
        newPaths.push(path);
      }
      setUploadedPaths((prev) => [...prev, ...newPaths]);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Fotoğraf yüklenemedi');
    } finally {
      setUploading(false);
    }
  };

  const removeUploaded = (path: string) => {
    setUploadedPaths((prev) => prev.filter((p) => p !== path));
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    if (!description.trim()) {
      setCreateError('Açıklama zorunludur.');
      return;
    }

    setCreating(true);
    try {
      const created = await createIssue({
        property_id: propertyId,
        unit_id: unitId,
        description: description.trim(),
        photo_paths: uploadedPaths,
        reported_by: reportedByUserId,
      });
      setIssues((prev) => (prev ? [created, ...prev] : [created]));
      setDescription('');
      setUploadedPaths([]);
      onChange();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Kaydedilemedi');
    } finally {
      setCreating(false);
    }
  };

  const handleResolve = async (issue: HousekeepingIssue) => {
    setResolvingId(issue.id);
    try {
      const updated = await updateIssueStatus(issue.id, 'RESOLVED');
      setIssues((prev) =>
        prev ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev,
      );
      onChange();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Durum güncellenemedi');
    } finally {
      setResolvingId(null);
    }
  };

  const handleDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteIssue(toDelete.id, toDelete.photo_paths);
      setIssues((prev) => (prev ? prev.filter((i) => i.id !== toDelete.id) : prev));
      setToDelete(null);
      onChange();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Silinemedi');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-16"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              {unitName} — Sorunlar
            </h2>
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

        {/* New issue form */}
        {canWrite && (
          <form onSubmit={handleCreate} className="mb-6 space-y-3" noValidate>
            <div>
              <label
                htmlFor="issue-description"
                className="block text-sm font-medium text-stone-700 dark:text-stone-300"
              >
                Yeni Sorun
              </label>
              <textarea
                id="issue-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Sorunu kısaca açıklayın (örn. klima çalışmıyor, duşta sızıntı var)"
                rows={3}
                maxLength={500}
                className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder:text-stone-500"
              />
            </div>

            {/* Photo picker */}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFilesPicked}
                  className="hidden"
                  disabled={uploading || uploadedPaths.length >= MAX_PHOTOS}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={uploading}
                  disabled={uploadedPaths.length >= MAX_PHOTOS}
                  onClick={() => fileInputRef.current?.click()}
                >
                  + Fotoğraf Ekle
                </Button>
                <span className="text-xs text-stone-600 dark:text-stone-300">
                  {uploadedPaths.length}/{MAX_PHOTOS} fotoğraf
                </span>
              </div>

              {uploadedPaths.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {uploadedPaths.map((p) => (
                    <div key={p} className="relative h-20 w-20">
                      <img
                        src={issuePhotoUrl(p)}
                        alt="Yüklenmiş fotoğraf"
                        className="h-full w-full rounded object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeUploaded(p)}
                        aria-label="Fotoğrafı kaldır"
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs text-white shadow hover:bg-red-700"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {createError && (
              <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                {createError}
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" loading={creating} disabled={uploading}>
                Sorun Bildir
              </Button>
            </div>
          </form>
        )}

        {/* Existing issues list */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium uppercase tracking-wide text-stone-600 dark:text-stone-300">
            Geçmiş Sorunlar
          </h3>

          {loadError && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {loadError}
            </p>
          )}

          {!loadError && issues === null && (
            <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
          )}

          {issues && issues.length === 0 && (
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Bu birim için kayıtlı sorun yok.
            </p>
          )}

          {issues &&
            issues.map((issue) => (
              <div
                key={issue.id}
                className="rounded-md border border-stone-300 p-3 dark:border-stone-700"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="flex-1 whitespace-pre-wrap text-sm text-stone-900 dark:text-stone-100">
                    {issue.description}
                  </p>
                  <span
                    className={cn(
                      'rounded px-2 py-0.5 text-xs font-medium',
                      STATUS_BADGE[issue.status],
                    )}
                  >
                    {STATUS_LABELS[issue.status]}
                  </span>
                </div>

                {issue.photo_paths.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {issue.photo_paths.map((p) => (
                      <a
                        key={p}
                        href={issuePhotoUrl(p)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block h-20 w-20"
                      >
                        <img
                          src={issuePhotoUrl(p)}
                          alt="Sorun fotoğrafı"
                          className="h-full w-full rounded object-cover transition-opacity hover:opacity-80"
                        />
                      </a>
                    ))}
                  </div>
                )}

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-stone-600 dark:text-stone-300">
                    {new Date(issue.created_at).toLocaleString('tr-TR')}
                    {issue.reported_by && staffMap.get(issue.reported_by) && (
                      <> · Oluşturan: {staffMap.get(issue.reported_by)}</>
                    )}
                  </span>
                  <div className="flex gap-2">
                    {canWrite && issue.status !== 'RESOLVED' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={resolvingId === issue.id}
                        onClick={() => handleResolve(issue)}
                      >
                        Çözüldü olarak işaretle
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => {
                          setDeleteError(null);
                          setToDelete(issue);
                        }}
                      >
                        Sil
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
        </div>

        <ConfirmDialog
          open={toDelete !== null}
          title={toDelete ? 'Bu sorun silinsin mi?' : ''}
          description="Bu sorun Çöp Kutusu'na taşınır ve oradan geri yüklenebilir."
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
      </Card>
    </div>
  );
}
