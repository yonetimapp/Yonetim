import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';

type Mode = 'signin' | 'signup';

// Supabase auth errors come back in English. Map the ones a staff member can
// realistically hit to Turkish; fall back to the raw message for the rest.
function translateAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'E-posta veya şifre hatalı.';
  if (m.includes('email not confirmed'))
    return 'E-posta adresiniz henüz doğrulanmadı. Gelen kutunuzdaki doğrulama linkine tıklayın.';
  if (m.includes('user already registered') || m.includes('already been registered'))
    return 'Bu e-posta adresi zaten kayıtlı.';
  if (m.includes('password should be at least'))
    return 'Şifre en az 6 karakter olmalıdır.';
  if (m.includes('unable to validate email address') || m.includes('invalid email'))
    return 'Geçersiz e-posta adresi.';
  if (m.includes('signups not allowed') || m.includes('signup is disabled'))
    return 'Yeni kayıt şu anda kapalı.';
  if (m.includes('email rate limit') || m.includes('over_email_send_rate_limit'))
    return 'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.';
  return message;
}

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { signIn, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from =
    (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/dashboard';

  if (user) {
    navigate(from, { replace: true });
  }

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setInfo(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);

    if (mode === 'signin') {
      const { error: signInError } = await signIn(email, password);
      setSubmitting(false);
      if (signInError) {
        setError(translateAuthError(signInError.message));
      } else {
        navigate(from, { replace: true });
      }
      return;
    }

    // ----- signup -----
    const trimmedName = fullName.trim();
    if (!trimmedName) {
      setError('Ad Soyad zorunludur.');
      setSubmitting(false);
      return;
    }
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: trimmedName } },
    });
    setSubmitting(false);
    if (signUpError) {
      setError(translateAuthError(signUpError.message));
      return;
    }
    if (data.session) {
      // Email confirmation is OFF — user is already signed in.
      // The on_auth_user_created trigger has just inserted a staff_profiles
      // row with role=PENDING (migration 032); useAuth picks it up momentarily
      // and the layout routes them to the pending-approval screen.
      navigate(from, { replace: true });
    } else {
      // Email confirmation is ON — user must verify before they can sign in.
      setInfo('Hesap oluşturuldu. Lütfen e-postanıza gelen doğrulama linkine tıklayın, ardından giriş yapın.');
      setMode('signin');
    }
  };

  const isSignup = mode === 'signup';

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-4 dark:bg-stone-950">
      <form
        onSubmit={handleSubmit}
        noValidate
        className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-700 dark:bg-stone-900"
      >
        <h1 className="mb-1 text-2xl font-semibold text-emerald-600 dark:text-emerald-500">
          HomeGuru
        </h1>
        <p className="mb-6 text-sm text-stone-600 dark:text-stone-300">
          {isSignup ? 'Yeni personel hesabı' : 'Personel girişi'}
        </p>

        {isSignup && (
          <label className="block text-sm font-medium text-stone-700 dark:text-stone-300">
            Ad Soyad
            <input
              type="text"
              autoComplete="name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              maxLength={120}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-stone-900 placeholder-stone-400 focus:border-emerald-500 focus:outline-none dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500"
            />
          </label>
        )}

        <label
          className={
            isSignup
              ? 'mt-4 block text-sm font-medium text-stone-700 dark:text-stone-300'
              : 'block text-sm font-medium text-stone-700 dark:text-stone-300'
          }
        >
          E-posta
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-stone-900 placeholder-stone-400 focus:border-emerald-500 focus:outline-none dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500"
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-stone-700 dark:text-stone-300">
          Şifre
          <input
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            required
            minLength={isSignup ? 6 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-stone-900 placeholder-stone-400 focus:border-emerald-500 focus:outline-none dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500"
          />
          {isSignup && (
            <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">
              En az 6 karakter.
            </span>
          )}
        </label>

        {error && (
          <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400">
            {error}
          </p>
        )}
        {info && (
          <p className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
            {info}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-6 w-full rounded-md bg-emerald-600 px-4 py-2 font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          {isSignup
            ? submitting
              ? 'Hesap oluşturuluyor…'
              : 'Hesap Oluştur'
            : submitting
              ? 'Giriş yapılıyor…'
              : 'Giriş Yap'}
        </button>

        {isSignup && (
          <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
            Yeni hesaplar onay bekleyen olarak açılır. Bir yönetici hesabınızı
            onaylayıp rol atayana kadar uygulamadaki hiçbir veriye erişemezsiniz.
          </p>
        )}

        <p className="mt-5 text-center text-sm text-stone-600 dark:text-stone-300">
          {isSignup ? (
            <>
              Zaten hesabınız var mı?{' '}
              <button
                type="button"
                onClick={() => switchMode('signin')}
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
              >
                Giriş yapın
              </button>
            </>
          ) : (
            <>
              Hesabınız yok mu?{' '}
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
              >
                Hesap oluşturun
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
