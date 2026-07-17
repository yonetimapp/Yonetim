import { useEffect, useState, type FormEvent } from 'react';
import {
  listRegionsWithKasa,
  createRegion,
  renameRegion,
  deleteRegion,
  type RegionWithKasa,
} from '@/lib/queries/regions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FinanceTabs } from './FinanceTabs';
import { formatTRY } from '@/lib/utils';

/**
 * Bölgeler — the Yönetici's region admin (SUPER_ADMIN only, route-guarded).
 *
 * Each region owns exactly one kasa, created with it by the create_region RPC.
 * The default region ('Genel') can be renamed but never deleted, and a region
 * still holding mülk / personel / gider / kasa hareketi is refused by the RPC —
 * we surface that Turkish error as-is rather than second-guessing it here.
 */
export function RegionsPage() {
  const [regions, setRegions] = useState<RegionWithKasa[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editing, setEditing] = useState<RegionWithKasa | null>(null);
  const [editName, setEditName] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [toDelete, setToDelete] = useState<RegionWithKasa | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = () =>
    listRegionsWithKasa()
      .then(setRegions)
      .catch((e) => setError(e instanceof Error ? e.message : 'Bölgeler yüklenemedi'));

  useEffect(() => {
    void reload();
  }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createRegion(name);
      setNewName('');
      await reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Bölge oluşturulamadı');
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const name = editName.trim();
    if (!name || name === editing.name) {
      setEditing(null);
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      await renameRegion(editing.id, name);
      setEditing(null);
      await reload();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Bölge adı değiştirilemedi');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRegion(toDelete.id);
      setToDelete(null);
      await reload();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Bölge silinemedi');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Bölgeler</h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Her bölgenin kendi kasası vardır. Mülkler ve personel bir bölgeye bağlanır.
          </p>
        </div>
        <FinanceTabs />
      </div>

      {/* Yeni bölge */}
      <Card>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <Input
              label="Yeni bölge adı"
              name="new_region"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="örn. Merkez"
              maxLength={60}
            />
          </div>
          <Button type="submit" loading={creating} disabled={!newName.trim()}>
            + Bölge Ekle
          </Button>
        </form>
        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
          Bölge eklendiğinde aynı adla bir kasa da otomatik oluşturulur.
        </p>
        {createError && (
          <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {createError}
          </p>
        )}
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!error && regions === null && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {regions && regions.length > 0 && (
        <div className="space-y-2">
          {regions.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-stone-900 dark:text-stone-100">
                      {r.name}
                    </h2>
                    {r.is_default && (
                      <span className="rounded bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200">
                        Varsayılan
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                    {r.kasa_id ? `Kasa: ${r.kasa_name}` : 'Kasa bulunamadı'}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="text-xs text-stone-500 dark:text-stone-400">Kasa bakiyesi</p>
                    <p className="font-semibold text-stone-900 dark:text-stone-100">
                      {formatTRY(r.balance)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditError(null);
                      setEditName(r.name);
                      setEditing(r);
                    }}
                  >
                    Yeniden Adlandır
                  </Button>
                  {!r.is_default && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDeleteError(null);
                        setToDelete(r);
                      }}
                    >
                      <span className="text-red-600 dark:text-red-400">Sil</span>
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Rename modal */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-24"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
        >
          <Card className="w-full max-w-md">
            <h2 className="mb-3 text-lg font-semibold text-stone-900 dark:text-stone-100">
              Bölgeyi yeniden adlandır
            </h2>
            <form onSubmit={handleRename} className="space-y-3">
              <Input
                label="Bölge adı"
                name="edit_region"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={60}
                autoFocus
              />
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Ad değişikliği bu bölgeye bağlı tüm kayıtlara (mülk, personel, gider, kasa)
                otomatik yansır.
              </p>
              {editError && (
                <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                  {editError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  Vazgeç
                </Button>
                <Button type="submit" loading={savingEdit} disabled={!editName.trim()}>
                  Kaydet
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="Bölge silinsin mi?"
        description={
          toDelete ? (
            <>
              <p>
                <strong>{toDelete.name}</strong> bölgesi ve kasası silinir.
              </p>
              <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
                Bölgeye bağlı mülk, personel, gider veya kasa hareketi varsa silme
                reddedilir — önce onları başka bir bölgeye taşıyın.
              </p>
            </>
          ) : null
        }
        confirmLabel="Sil"
        cancelLabel="Vazgeç"
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
