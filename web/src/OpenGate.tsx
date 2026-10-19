import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import type { Gate } from './types';

const FEEDBACK_MS = 3000;

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'opened'; name: string } | { kind: 'error'; text: string };

/**
 * Üst çubukta her sayfada görünen "Kapıyı aç" düğmesi.
 * Tek kapı varsa tek tıkla açar; birden çok kapı varsa küçük bir liste gösterir.
 */
export function OpenGateButton({ gymId, gates }: { gymId: number; gates: Gate[] | null }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const wrapRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  // Liste açıkken dışarı tıklanınca ya da Esc'ye basılınca kapanır
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const list = gates ?? [];
  const anyOnline = list.some((g) => g.online);
  const waiting = state.kind === 'busy' || state.kind === 'opened'; // art arda basmayı engeller

  const hint =
    gates === null ? 'Kapılar yükleniyor…'
    : list.length === 0 ? 'Henüz kapı yok. Salon sahibi Kapılar sayfasından kapı eklemeli.'
    : !anyOnline ? (list.length === 1 ? 'Kapı çevrimdışı' : 'Hiçbir kapı çevrimiçi değil')
    : undefined;

  async function open(gate: Gate) {
    setMenuOpen(false);
    setState({ kind: 'busy' });
    try {
      await api.post(`/api/gyms/${gymId}/gates/${gate.id}/open`);
      setState({ kind: 'opened', name: gate.name });
    } catch (err) {
      setState({ kind: 'error', text: err instanceof ApiError ? err.message : 'Kapı açılamadı.' });
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState({ kind: 'idle' }), FEEDBACK_MS);
  }

  function onClick() {
    if (list.length === 1) void open(list[0]);
    else setMenuOpen((o) => !o);
  }

  const label = state.kind === 'busy' ? 'Açılıyor…' : state.kind === 'opened' ? 'Açıldı ✓' : 'Kapıyı aç';

  return (
    <div className="open-gate" ref={wrapRef}>
      <button
        type="button"
        className={`btn open-gate-btn${state.kind === 'opened' ? ' opened' : ''}`}
        onClick={onClick}
        disabled={Boolean(hint) || waiting}
        title={hint}
        aria-haspopup={list.length > 1 ? 'menu' : undefined}
        aria-expanded={list.length > 1 ? menuOpen : undefined}
      >
        {label}
        {list.length > 1 && state.kind === 'idle' && <span aria-hidden="true"> ▾</span>}
      </button>

      {menuOpen && (
        <ul className="gate-menu" role="menu">
          {list.map((g) => (
            <li key={g.id} role="none">
              <button type="button" role="menuitem" disabled={!g.online} onClick={() => open(g)}>
                <span>{g.name}</span>
                <span className={`dot ${g.online ? 'dot-on' : 'dot-off'}`}>{g.online ? 'çevrimiçi' : 'çevrimdışı'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.kind === 'error' && <p className="gate-error error" role="alert">{state.text}</p>}
      <span className="sr-only" role="status" aria-live="polite">
        {state.kind === 'opened' ? `${state.name} açıldı` : ''}
      </span>
    </div>
  );
}
