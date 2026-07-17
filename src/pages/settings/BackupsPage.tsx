import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

/**
 * Yedekler — browsable cloud backup (SUPER_ADMIN only; route-guarded AND
 * RLS-gated: the `backups` bucket's only policy is SUPER_ADMIN SELECT,
 * migration 129). The daily GitHub Action uploads one folder per day
 * (YYYY-MM-DD/) holding the full `db.dump` plus one CSV per table, and prunes
 * folders older than 14 days. Files download via short-lived signed URLs.
 */

interface BackupFile {
  name: string;
  size: number | null;
}

function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function BackupsPage() {
  const [days, setDays] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByDay, setFilesByDay] = useState<Record<string, BackupFile[]>>({});
  const [filesError, setFilesError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error: e } = await supabase.storage
        .from('backups')
        .list('', { limit: 200, sortBy: { column: 'name', order: 'desc' } });
      if (e) {
        setError(e.message);
        return;
      }
      // Top level of the bucket: one folder per day. Folders come back without
      // an object id; anything else (stray root files) is ignored.
      setDays((data ?? []).filter((it) => !it.id && DAY_RE.test(it.name)).map((it) => it.name));
    })();
  }, []);

  const toggleDay = async (day: string) => {
    setFilesError(null);
    setDownloadError(null);
    if (expanded === day) {
      setExpanded(null);
      return;
    }
    setExpanded(day);
    if (filesByDay[day]) return; // already loaded
    const { data, error: e } = await supabase.storage
      .from('backups')
      .list(day, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
    if (e) {
      setFilesError(e.message);
      return;
    }
    setFilesByDay((prev) => ({
      ...prev,
      [day]: (data ?? [])
        .filter((it) => Boolean(it.id))
        .map((it) => ({
          name: it.name,
          size: typeof it.metadata?.size === 'number' ? it.metadata.size : null,
        })),
    }));
  };

  const download = async (day: string, file: string) => {
    const path = `${day}/${file}`;
    setDownloading(path);
    setDownloadError(null);
    try {
      const { data, error: e } = await supabase.storage
        .from('backups')
        .createSignedUrl(path, 300, { download: true });
      if (e || !data?.signedUrl) {
        throw new Error(e?.message ?? 'İndirme bağlantısı oluşturulamadı');
      }
      window.open(data.signedUrl, '_blank', 'noopener');
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'İndirilemedi');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Yedekler</h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Her gece alınan veritabanı yedeği: tam yedek (<code>db.dump</code>) ve tablo
          başına bir CSV. Son 14 gün saklanır.
        </p>
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!error && days === null && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {days && days.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Henüz yedek yok. Yedekler her gece otomatik yüklenir — kurulum için
            SETUP.md §10&apos;daki depolama gizli anahtarlarının GitHub&apos;a eklenmiş
            olması gerekir.
          </p>
        </Card>
      )}

      {days && days.length > 0 && (
        <div className="space-y-2">
          {days.map((day) => (
            <Card key={day} className="p-0">
              <button
                type="button"
                onClick={() => void toggleDay(day)}
                className="flex w-full items-center justify-between px-6 py-3 text-left transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50"
              >
                <span className="font-semibold text-stone-900 dark:text-stone-100">{day}</span>
                <svg
                  className={`h-4 w-4 text-stone-500 transition-transform dark:text-stone-300 ${
                    expanded === day ? 'rotate-180' : ''
                  }`}
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M5 8l5 5 5-5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {expanded === day && (
                <div className="border-t border-stone-200 px-6 py-3 dark:border-stone-700">
                  {filesError && (
                    <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                      {filesError}
                    </p>
                  )}
                  {!filesError && !filesByDay[day] && (
                    <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
                  )}
                  {filesByDay[day] && filesByDay[day].length === 0 && (
                    <p className="text-sm text-stone-600 dark:text-stone-300">
                      Bu klasör boş.
                    </p>
                  )}
                  {filesByDay[day] && filesByDay[day].length > 0 && (
                    <ul className="divide-y divide-stone-200 dark:divide-stone-700">
                      {filesByDay[day].map((f) => {
                        const path = `${day}/${f.name}`;
                        return (
                          <li
                            key={f.name}
                            className="flex items-center justify-between gap-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm text-stone-900 dark:text-stone-100">
                                {f.name}
                              </p>
                              {f.size != null && (
                                <p className="text-xs text-stone-500 dark:text-stone-400">
                                  {formatBytes(f.size)}
                                </p>
                              )}
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={downloading === path}
                              onClick={() => void download(day, f.name)}
                            >
                              İndir
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {downloadError && (
                    <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                      {downloadError}
                    </p>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
