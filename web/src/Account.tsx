import { useState, type FormEvent } from 'react';
import { ApiError, api, setToken } from './api';
import { ErrorNote, Field, Modal } from './ui';

/** Hesabım: şifre değiştirme ve tüm cihazlardan çıkış. */
export function AccountModal({ name, email, onClose, onLogout }: { name: string; email: string; onClose: () => void; onLogout: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const current = String(data.get('current'));
    const next = String(data.get('next'));
    if (next !== String(data.get('confirm'))) {
      setError('Yeni şifreler birbiriyle aynı değil.');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await api.post<{ token: string }>('/api/auth/change-password', { currentPassword: current, newPassword: next });
      setToken(res.token); // bu cihaz oturumda kalır, diğer cihazlar düşer
      form.reset();
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Şifre değiştirilemedi.');
    } finally {
      setBusy(false);
    }
  }

  async function logoutEverywhere() {
    setBusy(true);
    try {
      await api.post('/api/auth/logout-all');
    } catch {
      /* oturum zaten düşmüşse de çıkış yapılır */
    }
    onLogout();
  }

  return (
    <Modal title="Hesabım" onClose={onClose}>
      <div className="stack">
        <p className="muted">{name} · {email}</p>
        <form onSubmit={changePassword} className="stack">
          <Field label="Mevcut şifre">
            <input name="current" type="password" required autoComplete="current-password" />
          </Field>
          <Field label="Yeni şifre" hint="En az 8 karakter">
            <input name="next" type="password" required minLength={8} autoComplete="new-password" />
          </Field>
          <Field label="Yeni şifre (tekrar)">
            <input name="confirm" type="password" required minLength={8} autoComplete="new-password" />
          </Field>
          <ErrorNote message={error} />
          {done && <p className="success" role="status">Şifre değişti. Diğer cihazlardaki oturumlar kapatıldı.</p>}
          <button type="submit" className="btn primary" disabled={busy}>Şifreyi değiştir</button>
        </form>
        <hr className="divider" />
        <div className="stack">
          <p className="muted">Telefonunuzu kaybettiyseniz veya ortak bir bilgisayar kullandıysanız tüm oturumları kapatın.</p>
          <button type="button" className="btn" onClick={logoutEverywhere} disabled={busy}>Tüm cihazlardan çıkış yap</button>
        </div>
      </div>
    </Modal>
  );
}
