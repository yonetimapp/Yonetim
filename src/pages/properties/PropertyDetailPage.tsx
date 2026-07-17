import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can, baseRole } from '@/lib/rbac';
import {
  getProperty,
  deleteProperty,
  updateProperty,
  type Property,
} from '@/lib/queries/properties';
import { listUnitsForProperty, deleteUnit, type Unit } from '@/lib/queries/units';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cn, formatTRY, formatRoomType } from '@/lib/utils';
import { propertyPhotoUrl, deletePropertyPhotos } from '@/lib/photos';

export function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // "← Geri" returns to where the user came from; fall back to the list only on
  // a direct/deep-link entry (no in-app history).
  const goBack = () =>
    location.key === 'default' ? navigate('/properties') : navigate(-1);

  const [property, setProperty] = useState<Property | null>(null);
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteProperty, setConfirmDeleteProperty] = useState(false);
  const [unitToDelete, setUnitToDelete] = useState<Unit | null>(null);
  const [busy, setBusy] = useState(false);
  /** The mülk photo pending removal (a mülk carries exactly one). */
  const [photoToDelete, setPhotoToDelete] = useState<{ path: string } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setError(null);
    Promise.all([getProperty(id), listUnitsForProperty(id)])
      .then(([p, u]) => {
        if (!p) {
          setError('Mülk bulunamadı');
          return;
        }
        setProperty(p);
        setUnits(u);
      })
      .catch((e) => setError(e.message ?? 'Yüklenemedi'));
  }, [id]);

  if (error) {
    return (
      <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        <button type="button" onClick={goBack} className="mt-3 inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500">
          ← Geri
        </button>
      </Card>
    );
  }

  if (!property || !units) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  const isAdmin = profile && can(profile.role, 'admin:*');
  const canManageProperty = isAdmin;
  const canManageUnits =
    profile &&
    (isAdmin ||
      baseRole(profile.role) === 'PROPERTY_MANAGER' ||
      baseRole(profile.role) === 'YETKILI');
  const isApartmentFull = property.type === 'APARTMENT' && units.length >= 1;

  const handleDeleteProperty = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await deleteProperty(id);
      navigate('/properties', { replace: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Silme başarısız';
      setError(msg);
      setBusy(false);
      setConfirmDeleteProperty(false);
    }
  };

  const handleDeleteUnit = async () => {
    if (!unitToDelete) return;
    setBusy(true);
    try {
      await deleteUnit(unitToDelete.id);
      setUnits((prev) => prev?.filter((u) => u.id !== unitToDelete.id) ?? null);
      setUnitToDelete(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Silme başarısız';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Promote a photo to position 0 → it becomes the card thumbnail on the
   * Mülkler list. Persists the reordered array via updateProperty.
   */
  const handleSetCover = async (path: string) => {
    if (!property) return;
    if (property.photo_paths[0] === path) return; // already cover
    const nextPaths = [path, ...property.photo_paths.filter((p) => p !== path)];
    // Optimistic update so the star fills instantly.
    const prev = property;
    setProperty({ ...property, photo_paths: nextPaths });
    try {
      await updateProperty(property.id, { photo_paths: nextPaths });
    } catch (e) {
      setProperty(prev); // revert on failure
      setError(e instanceof Error ? e.message : 'Kapak değiştirilemedi');
    }
  };

  const handleDeletePhoto = async () => {
    if (!photoToDelete || !property) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const nextPaths = property.photo_paths.filter((p) => p !== photoToDelete.path);
      await updateProperty(property.id, { photo_paths: nextPaths });
      await deletePropertyPhotos([photoToDelete.path]);
      setProperty({ ...property, photo_paths: nextPaths });
      setPhotoToDelete(null);
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : 'Fotoğraf silinemedi');
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={goBack}
        className="inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500"
      >
        ← Geri
      </button>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            {property.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={
                property.type === 'HOTEL'
                  ? 'rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                  : 'rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
              }
            >
              {property.type === 'HOTEL' ? 'Bina' : 'Daire'}
            </span>
            {property.region && (
              <span className="rounded bg-sky-100 px-2 py-0.5 text-xs font-medium capitalize text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                Bölge: {property.region}
              </span>
            )}
            {property.address && (
              <span className="text-sm text-stone-600 dark:text-stone-300">{property.address}</span>
            )}
          </div>
        </div>
        {canManageProperty && (
          <div className="flex gap-2">
            <Link to={`/properties/${property.id}/edit`}>
              <Button variant="secondary" size="sm">
                Düzenle
              </Button>
            </Link>
            <Button variant="danger" size="sm" onClick={() => setConfirmDeleteProperty(true)}>
              Sil
            </Button>
          </div>
        )}
      </div>

      {/* Units */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Birimler ({units.length})
          </h2>
          {canManageUnits && !isApartmentFull && (
            <Link to={`/properties/${property.id}/units/new`}>
              <Button size="sm">+ Yeni Birim</Button>
            </Link>
          )}
        </div>

        {isApartmentFull && (
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            Daire tipi mülkler yalnızca tek birim içerebilir.
          </p>
        )}

        {units.length === 0 ? (
          <p className="py-4 text-center text-sm text-stone-600 dark:text-stone-300">
            Henüz birim eklenmemiş.
          </p>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="space-y-3 sm:hidden">
              {units.map((u) => (
                <div
                  key={u.id}
                  className="rounded-lg border border-stone-200 p-3 dark:border-stone-700"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-stone-900 dark:text-stone-100">{u.name}</p>
                      <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
                        {formatRoomType(u.room_type)} · {u.capacity} kişi
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold text-stone-900 dark:text-stone-100">
                      {formatTRY(u.base_price)}
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    {canManageUnits && (
                      <div className="flex gap-1">
                        <Link to={`/properties/${property.id}/units/${u.id}/edit`}>
                          <Button variant="ghost" size="sm">
                            Düzenle
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                          onClick={() => setUnitToDelete(u)}
                        >
                          Sil
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Tablet+ : table */}
            <div className="-mx-6 hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-stone-200 text-xs uppercase text-stone-600 dark:border-stone-700 dark:text-stone-300">
                  <tr>
                    <th className="px-6 py-2 font-medium">Ad</th>
                    <th className="px-6 py-2 font-medium">Tip</th>
                    <th className="px-6 py-2 font-medium">Kapasite</th>
                    <th className="px-6 py-2 font-medium">Gecelik Ücret</th>
                    {canManageUnits && <th className="px-6 py-2"></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                  {units.map((u) => (
                    <tr key={u.id}>
                      <td className="px-6 py-3 font-medium text-stone-900 dark:text-stone-100">
                        {u.name}
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        {formatRoomType(u.room_type)}
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        {u.capacity} kişi
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        {formatTRY(u.base_price)}
                      </td>
                      {canManageUnits && (
                        <td className="px-6 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            <Link to={`/properties/${property.id}/units/${u.id}/edit`}>
                              <Button variant="ghost" size="sm">
                                Düzenle
                              </Button>
                            </Link>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                              onClick={() => setUnitToDelete(u)}
                            >
                              Sil
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {/* Photo gallery (rendered below units per design preference) */}
      {property.photo_paths && property.photo_paths.length > 0 && (
        <Card>
          <h2 className="mb-3 text-lg font-semibold text-stone-900 dark:text-stone-100">
            Fotoğraflar ({property.photo_paths.length})
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {property.photo_paths.map((p, i) => {
              const isCover = i === 0;
              return (
                <div key={p} className="relative aspect-square">
                  <a
                    href={propertyPhotoUrl(p)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block h-full w-full overflow-hidden rounded"
                  >
                    <img
                      src={propertyPhotoUrl(p)}
                      alt={`${property.name} fotoğrafı`}
                      className="h-full w-full object-cover transition-opacity hover:opacity-80"
                      loading="lazy"
                    />
                  </a>
                  {canManageProperty && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleSetCover(p)}
                        disabled={isCover}
                        aria-label={isCover ? 'Kapak fotoğrafı' : 'Kapak yap'}
                        title={isCover ? 'Kapak fotoğrafı' : 'Kapak yap'}
                        className={cn(
                          'absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded-full text-sm shadow',
                          isCover
                            ? 'cursor-default bg-amber-400 text-white'
                            : 'bg-stone-900/60 text-white hover:bg-amber-500',
                        )}
                      >
                        ★
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPhotoError(null);
                          setPhotoToDelete({ path: p });
                        }}
                        aria-label="Fotoğrafı sil"
                        title="Fotoğrafı sil"
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-600/90 text-xs text-white shadow hover:bg-red-700"
                      >
                        ×
                      </button>
                    </>
                  )}
                  {isCover && (
                    <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white shadow">
                      Kapak
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Confirm delete property — two-step (type the name to enable Sil) */}
      <ConfirmDialog
        open={confirmDeleteProperty}
        title={`"${property.name}" silinsin mi?`}
        description={
          <>
            <p>
              Bu işlem <strong>geri alınamaz</strong>. Mülkün birimleri, temizlik
              geçmişi ve takvim verileri (bloklar, notlar, fiyatlar) kalıcı olarak
              silinir. Çöp Kutusu'na taşınmaz.
            </p>
            <p className="mt-2">
              Geçmiş{' '}
              <strong>rezervasyonlar, kasa hareketleri ve giderler korunur</strong>{' '}
              — mülkle bağları kopar ve “silinmiş olan {property.name}” olarak
              görünmeye devam eder.
            </p>
            <p className="mt-2 font-medium">
              Not: Aktif (devam eden) rezervasyonu olan mülkler silinemez.
            </p>
          </>
        }
        confirmLabel="Kalıcı Sil"
        destructive
        loading={busy}
        requireText={property.name}
        onConfirm={handleDeleteProperty}
        onCancel={() => setConfirmDeleteProperty(false)}
      />

      {/* Confirm delete unit */}
      <ConfirmDialog
        open={!!unitToDelete}
        title={unitToDelete ? `"${unitToDelete.name}" silinsin mi?` : ''}
        description={
          <>
            <p>Birim Çöp Kutusu'na taşınır ve oradan geri yüklenebilir.</p>
            <p className="mt-2">
              Geçmiş <strong>rezervasyonlar korunur</strong> — birimle bağları
              kopar ve “silinmiş olan{' '}
              {unitToDelete ? unitToDelete.name : 'birim'}” olarak görünmeye
              devam eder. Geri yüklemede bu bağ geri gelmez.
            </p>
            <p className="mt-2 font-medium">
              Not: Aktif (devam eden) rezervasyonu olan birimler silinemez.
            </p>
          </>
        }
        confirmLabel="Sil"
        destructive
        loading={busy}
        onConfirm={handleDeleteUnit}
        onCancel={() => setUnitToDelete(null)}
      />

      {/* Confirm photo delete */}
      <ConfirmDialog
        open={photoToDelete !== null}
        title="Bu fotoğraf silinsin mi?"
        description="Geri alınamaz. Fotoğraf hem listeden hem depolamadan kaldırılır."
        confirmLabel="Sil"
        destructive
        loading={photoBusy}
        error={photoError}
        onConfirm={handleDeletePhoto}
        onCancel={() => {
          setPhotoToDelete(null);
          setPhotoError(null);
        }}
      />
    </div>
  );
}
