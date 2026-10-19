import { api } from '../api';
import { REASON_TEXT, formatDateTime } from '../format';
import { useLoad } from '../hooks';
import type { Entry, Summary } from '../types';
import { Badge, PageState } from '../ui';

export function Dashboard({ gymId }: { gymId: number }) {
  const summary = useLoad(() => api.get<Summary>(`/api/gyms/${gymId}`), [gymId], 10_000);
  const entries = useLoad(() => api.get<Entry[]>(`/api/gyms/${gymId}/entries?limit=8`), [gymId], 10_000);
  const stats = summary.data?.stats;

  return (
    <>
      <h1>Özet</h1>
      <PageState loading={summary.loading} error={summary.error}>
        {stats && (
          <div className="stats">
            <Stat label="Aktif üyelik" value={stats.activeMembers} note={`${stats.totalMembers} kayıtlı üye`} />
            <Stat label="Son 24 saatte giriş" value={stats.entriesLast24h} />
            <Stat
              label="Çevrimiçi kapı"
              value={`${stats.gatesOnline}/${stats.gatesTotal}`}
              tone={stats.gatesTotal > 0 && stats.gatesOnline < stats.gatesTotal ? 'warn' : undefined}
              note={stats.gatesTotal === 0 ? 'Henüz kapı eklenmedi' : undefined}
            />
          </div>
        )}
      </PageState>

      <h2>Son girişler</h2>
      <PageState loading={entries.loading} error={entries.error} empty={entries.data?.length === 0 && 'Henüz giriş kaydı yok.'}>
        <ul className="feed">
          {entries.data?.map((e) => (
            <li key={e.id}>
              <span className="feed-time">{formatDateTime(e.at)}</span>
              <span className="feed-name">{e.memberName}</span>
              {e.allowed ? <Badge tone="ok">Geçti</Badge> : <Badge tone="bad">{REASON_TEXT[e.reason ?? ''] ?? 'Reddedildi'}</Badge>}
            </li>
          ))}
        </ul>
      </PageState>
    </>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: number | string; note?: string; tone?: 'warn' }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}
