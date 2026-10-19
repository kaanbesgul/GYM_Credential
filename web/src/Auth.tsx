import { useState, type FormEvent } from 'react';
import { ApiError, api, setToken } from './api';
import { ErrorNote, Field } from './ui';

interface TokenResponse {
  token: string;
}

export function AuthScreen({ onToken }: { onToken: (token: string) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === 'login'
          ? await api.post<TokenResponse>('/api/auth/login', { email: value('email'), password: String(form.get('password')) })
          : await api.post<TokenResponse>('/api/auth/signup-gym', {
              gymName: value('gymName'),
              name: value('name'),
              email: value('email'),
              password: String(form.get('password')),
            });
      setToken(res.token);
      onToken(res.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bağlantı kurulamadı.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>GYM Enter</span>
        </div>
        <h1>{mode === 'login' ? 'Salon paneline giriş' : 'Salonunu kaydet'}</h1>

        <form onSubmit={submit} className="stack">
          {mode === 'signup' && (
            <>
              <Field label="Salon adı">
                <input name="gymName" required maxLength={100} autoComplete="organization" />
              </Field>
              <Field label="Adınız soyadınız">
                <input name="name" required maxLength={100} autoComplete="name" />
              </Field>
            </>
          )}
          <Field label="E-posta">
            <input name="email" type="email" required autoComplete="email" />
          </Field>
          <Field label="Şifre" hint={mode === 'signup' ? 'En az 8 karakter' : undefined}>
            <input
              name="password"
              type="password"
              required
              minLength={mode === 'signup' ? 8 : undefined}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>
          <ErrorNote message={error} />
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Lütfen bekleyin…' : mode === 'login' ? 'Giriş yap' : 'Salonu oluştur'}
          </button>
        </form>

        <p className="switch">
          {mode === 'login' ? (
            <>
              Salonunuz henüz kayıtlı değil mi?{' '}
              <button type="button" className="link" onClick={() => { setMode('signup'); setError(null); }}>
                Salonunu kaydet
              </button>
            </>
          ) : (
            <>
              Zaten hesabınız var mı?{' '}
              <button type="button" className="link" onClick={() => { setMode('login'); setError(null); }}>
                Giriş yap
              </button>
            </>
          )}
        </p>
      </div>
    </main>
  );
}

/** Hesabı hiçbir salonun yönetiminde olmayan kişiler için (ör. yalnızca üye uygulamasını kullananlar). */
export function NoGymScreen({ name, onCreated, onLogout }: { name: string; onCreated: () => void; onLogout: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const gymName = String(new FormData(e.currentTarget).get('gymName') ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/gyms', { name: gymName });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Salon oluşturulamadı.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <h1>Merhaba {name}</h1>
        <p className="muted">Bu hesap henüz bir salonun yönetiminde değil. Yeni bir salon oluşturabilirsiniz.</p>
        <form onSubmit={create} className="stack">
          <Field label="Salon adı">
            <input name="gymName" required maxLength={100} />
          </Field>
          <ErrorNote message={error} />
          <button type="submit" className="btn primary" disabled={busy}>Salonu oluştur</button>
          <button type="button" className="btn" onClick={onLogout}>Çıkış yap</button>
        </form>
      </div>
    </main>
  );
}
