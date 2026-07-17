import { useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

interface Props {
  onClose: () => void;
}

/**
 * Rol Bilgisi — read-only, plain-Turkish reference of what each of the 7 roles
 * can do, plus how region access works (re-release change #10). Shown from the
 * Personel screen, SUPER_ADMIN only (informational; no writes).
 *
 * Keep this text in sync with the actual permission surfaces: src/lib/rbac.ts,
 * App.tsx route guards, and the RLS policies (003/033/109/117/125).
 */
const ROLES: { name: string; can: string; cannot: string }[] = [
  {
    name: 'Yönetici (SUPER_ADMIN)',
    can: 'Her şey: tüm bölgeler, kasa ve finans, personel/rol/bölge atama, bölge ve mülk yönetimi, çöp kutusu, denetim kaydı, yedekler.',
    cannot: '—',
  },
  {
    name: 'Alt Yönetici (PROPERTY_MANAGER)',
    can: 'Rezervasyon ve misafir işlemleri, kasa ve giderler, tahsilat onayları, maaş/avans ödeme, temizlik, raporlar. Bölge kısıtlıysa yalnızca kendi bölgesinde.',
    cannot: 'Rol/bölge atama, personel maaşı düzenleme, mülk ekleme/silme, çöp kutusu, denetim kaydı, yedekler.',
  },
  {
    name: 'Personel (YETKILI)',
    can: 'Kendi bölgesinde tam operasyon: rezervasyon, misafir, birim düzenleme, temizlik, tahsilat (onaya düşer), gider girişi (onaya düşer).',
    cannot: 'Kasa, onaylar, borçlar, personel yönetimi. Girdiği tahsilat/gider bir yönetici onaylayana dek kasaya işlemez.',
  },
  {
    name: 'Resepsiyon (RECEPTION)',
    can: 'Rezervasyon ve misafir işlemleri; otel tipi mülklerde tahsilat.',
    cannot: 'Kasa ve giderler, temizlik durumu, personel, daire tipi mülklerde tahsilat.',
  },
  {
    name: 'Temizlik (HOUSEKEEPING)',
    can: 'Temizlik listesi ve durum güncelleme, sorun bildirme; daire tipi mülklerde teslimatta tahsilat (onaya düşer).',
    cannot: 'Rezervasyon/misafir düzenleme, kasa, giderler, otel tipi mülklerde tahsilat.',
  },
  {
    name: 'Teknik Personel (TEKNIK_PERSONEL)',
    can: 'TÜM bölgelerde rezervasyon listesini görme ve sorun bildirme. Bölge ayarı her zaman "tüm bölgeler"dir, kapatılamaz.',
    cannot: 'Temizlik durumu değiştirme, misafir bilgileri, mülkler, takvim/müsaitlik, kasa ve finans.',
  },
  {
    name: 'Onay Bekliyor (PENDING)',
    can: 'Hiçbir şey — yeni kayıt olan herkes bu rolle başlar ve hiçbir veri göremez.',
    cannot: 'Yönetici bir rol + bölge atayana kadar uygulama kilitlidir.',
  },
];

export function RoleInfoModal({ onClose }: Props) {
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Rol Bilgisi
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

        <div className="space-y-4">
          {ROLES.map((r) => (
            <div
              key={r.name}
              className="rounded-lg border border-stone-200 p-3 dark:border-stone-700"
            >
              <h3 className="font-semibold text-stone-900 dark:text-stone-100">{r.name}</h3>
              <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  Yapabilir:
                </span>{' '}
                {r.can}
              </p>
              <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">
                <span className="font-medium text-red-700 dark:text-red-400">Yapamaz:</span>{' '}
                {r.cannot}
              </p>
            </div>
          ))}

          <div className="rounded-lg bg-stone-100 p-3 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-300">
            <h3 className="font-semibold text-stone-900 dark:text-stone-100">
              Bölge erişimi nasıl çalışır?
            </h3>
            <p className="mt-1">
              Bölge erişimi rolden bağımsız, kişi başına bir ayardır (personel
              detayında &quot;Bölgeyi Değiştir&quot;). Her personelin bir{' '}
              <strong>ana bölgesi</strong> vardır: maaş ve avanslar o bölgenin
              kasasından ödenir. <strong>&quot;Tüm bölgeleri görebilir&quot;</strong>{' '}
              açılırsa kişi diğer bölgelerin mülk, rezervasyon ve bildirimlerini de
              görür; kapalıysa yalnızca kendi bölgesini görür. Kasa erişimi bu
              ayardan etkilenmez — her zaman role bağlıdır.
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Kapat
          </Button>
        </div>
      </Card>
    </div>
  );
}
