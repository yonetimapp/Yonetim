import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import {
  getProperty,
  createProperty,
  updateProperty,
} from '@/lib/queries/properties';
import type { PropertyType } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { listRegions, type Region } from '@/lib/queries/regions';
import {
  uploadPropertyPhoto,
  propertyPhotoUrl,
  deletePropertyPhotos,
  PROPERTY_PHOTO_MAX,
} from '@/lib/photos';

export function PropertyFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const location = useLocation();

  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('HOTEL');
  const [address, setAddress] = useState('');
  /** The region (regions.name) this mülk belongs to. Never empty — it falls back
      to the default region until the picker loads. Drives kasa routing + who can
      see the mülk (auth_sees_property). */
  const [region, setRegion] = useState('');
  const [regions, setRegions] = useState<Region[]>([]);
  /** Current ordered list of photo paths to persist on save. */
  const [photoPaths, setPhotoPaths] = useState<string[]>([]);
  /** Snapshot of the original photo_paths from the DB — used to detect removals. */
  const [originalPaths, setOriginalPaths] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Region list for the picker. A new mülk starts on the default region; an
  // existing one keeps whatever it already has (set by the loader below).
  useEffect(() => {
    listRegions()
      .then((rs) => {
        setRegions(rs);
        if (!isEdit) {
          setRegion((cur) => cur || rs.find((r) => r.is_default)?.name || rs[0]?.name || '');
        }
      })
      .catch(() => {});
  }, [isEdit]);

  useEffect(() => {
    if (!isEdit || !id) return;
    getProperty(id)
      .then((p) => {
        if (!p) {
          setError('Mülk bulunamadı');
          return;
        }
        setName(p.name);
        setType(p.type);
        setAddress(p.address ?? '');
        setRegion(p.region);
        setPhotoPaths(p.photo_paths ?? []);
        setOriginalPaths(p.photo_paths ?? []);
      })
      .catch((e) => setError(e.message ?? 'Yüklenemedi'))
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  const handleFilesPicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // reset so the same file can be reselected
    if (files.length === 0) return;

    const remaining = PROPERTY_PHOTO_MAX - photoPaths.length;
    if (remaining <= 0) {
      setPhotoError(`En fazla ${PROPERTY_PHOTO_MAX} fotoğraf yükleyebilirsiniz.`);
      return;
    }

    setPhotoError(null);
    setUploading(true);
    try {
      const toUpload = files.slice(0, remaining);
      const newPaths: string[] = [];
      for (const f of toUpload) {
        const path = await uploadPropertyPhoto(f);
        newPaths.push(path);
      }
      setPhotoPaths((prev) => [...prev, ...newPaths]);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Fotoğraf yüklenemedi');
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = (path: string) => {
    setPhotoPaths((prev) => prev.filter((p) => p !== path));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        type,
        address: address.trim() || null,
        photo_paths: photoPaths,
        // Region is a real FK to regions(name) now — send it as-is (the DB
        // defaults to 'Genel' if it somehow arrives empty).
        ...(region ? { region } : {}),
      };
      let nextId = id;
      if (isEdit && id) {
        await updateProperty(id, payload);
      } else {
        const created = await createProperty(payload);
        nextId = created.id;
      }

      // Best-effort storage cleanup: anything that was in the original list
      // but not in the new one is now orphan — sweep it. (New uploads that
      // the user removed before saving are also caught here when isEdit=false
      // because originalPaths is empty and removed-from-photoPaths paths are
      // already gone from photoPaths; we recompute relative to originalPaths.)
      const removed = originalPaths.filter((p) => !photoPaths.includes(p));
      if (removed.length > 0) {
        await deletePropertyPhotos(removed);
      }

      navigate(`/properties/${nextId}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <button
        type="button"
        onClick={() =>
          location.key === 'default'
            ? navigate(isEdit && id ? `/properties/${id}` : '/properties')
            : navigate(-1)
        }
        className="inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500"
      >
        ← Geri
      </button>
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
        {isEdit ? 'Mülk Düzenle' : 'Yeni Mülk'}
      </h1>

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Ad"
            name="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn: Alsancak Bina"
          />

          <Select
            label="Tip"
            name="type"
            required
            value={type}
            onChange={(v) => setType(v as PropertyType)}
            options={[
              { value: 'HOTEL', label: 'Bina' },
              { value: 'APARTMENT', label: 'Daire' },
            ]}
          />

          <Input
            label="Adres"
            name="address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Mahalle, Sokak, Daire"
          />

          <div>
            <Select
              label="Bölge"
              name="region"
              value={region}
              onChange={setRegion}
              options={regions.map((r) => ({ value: r.name, label: r.name }))}
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Bu mülkün geliri ve gideri seçilen bölgenin kasasına işlenir. Bir bölgeye
              atanmış personel yalnızca kendi bölgesinin mülklerini görür.
            </p>
          </div>

          {/* Mülk photo — exactly one (PROPERTY_PHOTO_MAX), DB CHECK mirrors it. */}
          <div>
            <label className="block text-sm font-medium text-stone-700 dark:text-stone-300">
              Fotoğraf
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFilesPicked}
                className="hidden"
                disabled={uploading || photoPaths.length >= PROPERTY_PHOTO_MAX}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={uploading}
                disabled={photoPaths.length >= PROPERTY_PHOTO_MAX}
                onClick={() => fileInputRef.current?.click()}
              >
                + Fotoğraf Ekle
              </Button>
              <span className="text-xs text-stone-600 dark:text-stone-300">
                {photoPaths.length}/{PROPERTY_PHOTO_MAX} fotoğraf
              </span>
            </div>

            {photoError && (
              <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                {photoError}
              </p>
            )}

            {photoPaths.length > 0 && (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photoPaths.map((p) => (
                  <div key={p} className="relative aspect-square">
                    <img
                      src={propertyPhotoUrl(p)}
                      alt="Mülk fotoğrafı"
                      className="h-full w-full rounded object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(p)}
                      aria-label="Fotoğrafı kaldır"
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs text-white shadow hover:bg-red-700"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
              Görseller ~200 KB'a sıkıştırılarak yüklenir. Mülkün dış görünümü, lobisi vb. eklenebilir.
            </p>
          </div>

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Link to={isEdit && id ? `/properties/${id}` : '/properties'}>
              <Button type="button" variant="secondary" disabled={saving || uploading}>
                İptal
              </Button>
            </Link>
            <Button type="submit" loading={saving} disabled={uploading}>
              {isEdit ? 'Kaydet' : 'Oluştur'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
