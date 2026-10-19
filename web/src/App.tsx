import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { AccountModal } from './Account';
import { AuthScreen, NoGymScreen } from './Auth';
import { useHash, useLoad } from './hooks';
import { OpenGateButton } from './OpenGate';
import { Audit } from './pages/Audit';
import { Dashboard } from './pages/Dashboard';
import { Entries } from './pages/Entries';
import { Gates } from './pages/Gates';
import { Members } from './pages/Members';
import { Plans } from './pages/Plans';
import { Staff } from './pages/Staff';
import type { Gate, Me } from './types';

// ownerOnly: yalnızca salon sahibine gösterilir (sunucu da aynı kuralı uygular)
const PAGES = [
  { id: 'ozet', label: 'Özet', ownerOnly: false },
  { id: 'uyeler', label: 'Üyeler', ownerOnly: false },
  { id: 'paketler', label: 'Paketler', ownerOnly: false },
  { id: 'girisler', label: 'Girişler', ownerOnly: false },
  { id: 'kapilar', label: 'Kapılar', ownerOnly: false },
  { id: 'calisanlar', label: 'Çalışanlar', ownerOnly: true },
  { id: 'denetim', label: 'Denetim', ownerOnly: true },
] as const;

const GYM_KEY = 'gym_enter_gym';

function readStoredGym(): number | null {
  try {
    const raw = localStorage.getItem(GYM_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [token, setTokenState] = useState<string | null>(getToken);
  const [me, setMe] = useState<Me | null>(null);
  const [loadingMe, setLoadingMe] = useState(Boolean(getToken()));

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setMe(null);
  }, []);

  const loadMe = useCallback(async () => {
    setLoadingMe(true);
    try {
      setMe(await api.get<Me>('/api/me'));
    } catch {
      // 401'de oturum zaten düşürülür; ağ hatasında giriş ekranına dönmek yeterli
      logout();
    } finally {
      setLoadingMe(false);
    }
  }, [logout]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    if (token) void loadMe();
  }, [token, loadMe]);

  if (!token) return <AuthScreen onToken={setTokenState} />;
  if (loadingMe || !me) return <main className="center muted">Yükleniyor…</main>;
  if (me.gyms.length === 0) return <NoGymScreen name={me.name} onCreated={loadMe} onLogout={logout} />;
  return <Shell me={me} onLogout={logout} onReloadMe={loadMe} />;
}

function Shell({ me, onLogout, onReloadMe }: { me: Me; onLogout: () => void; onReloadMe: () => void }) {
  const [hashPage, goTo] = useHash('ozet');
  const [showAccount, setShowAccount] = useState(false);
  const [gymId, setGymId] = useState<number>(() => {
    const stored = readStoredGym();
    return me.gyms.some((g) => g.id === stored) ? (stored as number) : me.gyms[0].id;
  });
  const gym = me.gyms.find((g) => g.id === gymId) ?? me.gyms[0];
  // Üst çubuktaki "Kapıyı aç" düğmesi her sayfada kapı durumunu bilsin diye burada yüklenir
  const gates = useLoad(() => api.get<Gate[]>(`/api/gyms/${gym.id}/gates`), [gym.id], 10_000);
  const isOwner = gym.role === 'owner';
  const visiblePages = PAGES.filter((p) => isOwner || !p.ownerOnly);
  // Yetkisiz olunan bir sayfa adresle açılırsa özete düşer
  const page = visiblePages.some((p) => p.id === hashPage) ? hashPage : 'ozet';

  function pickGym(id: number) {
    setGymId(id);
    try {
      localStorage.setItem(GYM_KEY, String(id));
    } catch {
      /* tercih kaydedilemezse sorun değil */
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>GYM Enter</span>
        </div>
        {me.gyms.length > 1 ? (
          <select value={gym.id} onChange={(e) => pickGym(Number(e.target.value))} aria-label="Salon seç" className="gym-picker">
            {me.gyms.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        ) : (
          <span className="gym-name">{gym.name}</span>
        )}
        <span className="spacer" />
        <OpenGateButton gymId={gym.id} gates={gates.data} />
        <button className="btn small ghost user" onClick={() => setShowAccount(true)} aria-label="Hesabım">{me.name}</button>
        <button className="btn small ghost" onClick={onLogout}>Çıkış</button>
      </header>

      <nav className="nav" aria-label="Sayfalar">
        {visiblePages.map((p) => (
          <a key={p.id} href={`#/${p.id}`} className={page === p.id ? 'active' : ''} aria-current={page === p.id ? 'page' : undefined} onClick={() => goTo(p.id)}>
            {p.label}
          </a>
        ))}
      </nav>

      <main className="content">
        {/* Salon değişince sayfa baştan yüklensin diye key kullanılır */}
        <div key={`${gym.id}-${page}`}>
          {page === 'uyeler' ? (
            <Members gymId={gym.id} />
          ) : page === 'paketler' ? (
            <Plans gymId={gym.id} isOwner={isOwner} />
          ) : page === 'girisler' ? (
            <Entries gymId={gym.id} isOwner={isOwner} />
          ) : page === 'kapilar' ? (
            <Gates gymId={gym.id} isOwner={isOwner} />
          ) : page === 'calisanlar' ? (
            <Staff gymId={gym.id} meId={me.id} onSelfChanged={onReloadMe} />
          ) : page === 'denetim' ? (
            <Audit gymId={gym.id} />
          ) : (
            <Dashboard gymId={gym.id} />
          )}
        </div>
      </main>

      {showAccount && <AccountModal name={me.name} email={me.email} onClose={() => setShowAccount(false)} onLogout={onLogout} />}
    </div>
  );
}
