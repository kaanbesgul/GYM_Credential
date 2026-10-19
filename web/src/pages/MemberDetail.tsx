import { useMemo, useState } from 'react';
import { api } from '../api';
import { dayKey } from '../dates';
import { REASON_TEXT, formatDate, formatTime } from '../format';
import { useLoad } from '../hooks';
import type { Entry, MemberDetail } from '../types';
import { Badge, Modal, PageState } from '../ui';

const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const MONTH_ENTRY_LIMIT = 500;

/**
 * Üye detayı: bilgiler, üyelik geçmişi ve hangi günler geldiği (aylık takvim).
 * Paket tanımlama ve devre dışı bırakma işlemlerini üst bileşen yürütür; `refreshKey` değişince veri yenilenir.
 */
export function MemberDetailModal({
  gymId,
  memberId,
  refreshKey,
  onClose,
  onAssign,
  onToggleActive,
}: {
  gymId: number;
  memberId: number;
  refreshKey: number;
  onClose: () => void;
  onAssign: () => void;
  onToggleActive: () => void;
}) {
  const detail = useLoad(() => api.get<MemberDetail>(`/api/gyms/${gymId}/members/${memberId}`), [gymId, memberId, refreshKey]);
  const m = detail.data;

  return (
    <Modal title={m?.name ?? 'Üye'} onClose={onClose} wide>
      <PageState loading={detail.loading && !m} error={detail.error}>
        {m && (
          <div className="stack">
            <div className="detail-top">
              <div>
                <div>{m.active ? <Badge tone="ok">Üyelik açık</Badge> : <Badge tone="muted">Devre dışı</Badge>}</div>
                <p className="sub">
                  {m.email}
                  {m.phone && ` · ${m.phone}`}
                  <br />
                  Salona kayıt: {formatDate(m.joinedAt)}
                </p>
              </div>
              <div className="detail-actions">
                <button type="button" className="btn small" onClick={onAssign} disabled={!m.active}>Paket tanımla</button>
                <button type="button" className="btn small ghost" onClick={onToggleActive}>
                  {m.active ? 'Devre dışı bırak' : 'Etkinleştir'}
                </button>
              </div>
            </div>

            <div className="mini-stats">
              <div><strong>{m.stats.visits}</strong><span>toplam giriş</span></div>
              <div><strong>{m.stats.visitsLast30}</strong><span>son 30 günde</span></div>
              <div><strong>{m.stats.lastVisitAt ? formatDate(m.stats.lastVisitAt) : '—'}</strong><span>son geliş</span></div>
              {m.stats.denied > 0 && <div><strong>{m.stats.denied}</strong><span>reddedilen</span></div>}
            </div>

            <section aria-label="Üyelik geçmişi">
              <h3>Üyelikler</h3>
              {m.memberships.length === 0 ? (
                <p className="muted">Henüz paket tanımlanmamış.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Paket</th><th>Tanımlandı</th><th>Bitiş</th><th>Durum</th></tr>
                    </thead>
                    <tbody>
                      {m.memberships.map((ms) => (
                        <tr key={ms.id}>
                          <td>{ms.plan}</td>
                          <td>{formatDate(ms.assignedAt)}</td>
                          <td>{formatDate(ms.endsAt)}</td>
                          <td>{ms.status === 'active' ? <Badge tone="ok">Aktif</Badge> : <Badge tone="muted">Sona erdi</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <VisitCalendar gymId={gymId} memberId={memberId} refreshKey={refreshKey} />
          </div>
        )}
      </PageState>
    </Modal>
  );
}

function VisitCalendar({ gymId, memberId, refreshKey }: { gymId: number; memberId: number; refreshKey: number }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [picked, setPicked] = useState<string | null>(null);

  const from = month;
  const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const entries = useLoad(
    () =>
      api.get<Entry[]>(
        `/api/gyms/${gymId}/entries?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), userId: String(memberId), limit: String(MONTH_ENTRY_LIMIT) })}`,
      ),
    [gymId, memberId, month.getTime(), refreshKey],
  );

  // Kayıtları yerel güne göre grupla
  const byDay = useMemo(() => {
    const map = new Map<string, { allowed: Entry[]; denied: Entry[] }>();
    for (const e of entries.data ?? []) {
      const key = dayKey(new Date(e.at));
      const bucket = map.get(key) ?? { allowed: [], denied: [] };
      (e.allowed ? bucket.allowed : bucket.denied).push(e);
      map.set(key, bucket);
    }
    return map;
  }, [entries.data]);

  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const leadingBlanks = (month.getDay() + 6) % 7; // takvim pazartesiyle başlar
  const today = new Date();
  const todayKey = dayKey(today);
  const isCurrentMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();

  const dayKeys = Array.from({ length: daysInMonth }, (_, i) => dayKey(new Date(month.getFullYear(), month.getMonth(), i + 1)));
  const attendedDays = dayKeys.filter((k) => (byDay.get(k)?.allowed.length ?? 0) > 0);
  const visits = attendedDays.reduce((sum, k) => sum + (byDay.get(k)?.allowed.length ?? 0), 0);
  const deniedCount = [...byDay.values()].reduce((sum, b) => sum + b.denied.length, 0);

  // Seçili gün yoksa (ya da ay değiştiyse) ayın en son geldiği günü göster
  const selected = picked && dayKeys.includes(picked) ? picked : (attendedDays.at(-1) ?? null);
  const selectedEntries = selected
    ? [...(byDay.get(selected)?.allowed ?? []), ...(byDay.get(selected)?.denied ?? [])].sort((a, b) => a.at.localeCompare(b.at))
    : [];

  function shift(delta: number) {
    setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
    setPicked(null);
  }

  return (
    <section aria-label="Geldiği günler">
      <div className="cal-nav">
        <h3>Geldiği günler</h3>
        <div className="cal-controls">
          <button type="button" className="btn small" onClick={() => shift(-1)} aria-label="Önceki ay">‹</button>
          <strong className="cal-month">{month.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })}</strong>
          <button type="button" className="btn small" onClick={() => shift(1)} disabled={isCurrentMonth} aria-label="Sonraki ay">›</button>
        </div>
      </div>

      <PageState loading={entries.loading && !entries.data} error={entries.error}>
        <p className="muted cal-summary">
          {attendedDays.length > 0
            ? `${attendedDays.length} gün geldi · ${visits} giriş`
            : 'Bu ay giriş yok'}
          {deniedCount > 0 && ` · ${deniedCount} reddedilen deneme`}
        </p>
        {(entries.data?.length ?? 0) >= MONTH_ENTRY_LIMIT && (
          <p className="muted">Bu ayda {MONTH_ENTRY_LIMIT}’den fazla kayıt var, ilk {MONTH_ENTRY_LIMIT} kayıt gösteriliyor.</p>
        )}

        <div className="cal" role="grid" aria-label={month.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })}>
          {WEEKDAYS.map((d) => (
            <div key={d} className="cal-head" role="columnheader">{d}</div>
          ))}
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <div key={`b${i}`} />
          ))}
          {dayKeys.map((key, i) => {
            const bucket = byDay.get(key);
            const came = (bucket?.allowed.length ?? 0) > 0;
            const onlyDenied = !came && (bucket?.denied.length ?? 0) > 0;
            const future = key > todayKey;
            const cls = ['cal-day', came && 'has-visit', onlyDenied && 'only-denied', key === todayKey && 'today', key === selected && 'selected']
              .filter(Boolean)
              .join(' ');
            const label = `${i + 1}. gün${came ? `, ${bucket!.allowed.length} giriş` : onlyDenied ? ', reddedilen deneme' : ''}`;
            return (
              <button key={key} type="button" className={cls} disabled={future} aria-label={label} aria-pressed={key === selected} onClick={() => setPicked(key)}>
                {i + 1}
                {(bucket?.allowed.length ?? 0) > 1 && <small>×{bucket!.allowed.length}</small>}
              </button>
            );
          })}
        </div>

        {selected && (
          <div className="cal-detail">
            <h4>{new Date(`${selected}T00:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' })}</h4>
            {selectedEntries.length === 0 ? (
              <p className="muted">Bu gün giriş yok.</p>
            ) : (
              <ul className="feed">
                {selectedEntries.map((e) => (
                  <li key={e.id}>
                    <span className="feed-time">{formatTime(e.at)}</span>
                    <span className="feed-name">{e.gateName ?? e.gateId}</span>
                    {e.allowed ? <Badge tone="ok">Geçti</Badge> : <Badge tone="bad">{REASON_TEXT[e.reason ?? ''] ?? 'Reddedildi'}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </PageState>
    </section>
  );
}
