import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, saveBlob } from '../api';
import { RANGES, computeBounds, dayKey, daysIn, isBounds, tzOffsetMinutes, type RangeKey } from '../dates';
import { REASON_TEXT, formatDate, formatDateTime } from '../format';
import type { Entry, EntrySummary } from '../types';
import { Badge, ErrorNote } from '../ui';

const PAGE_SIZE = 100;
const REFRESH_MS = 15_000;

type ResultFilter = 'all' | 'allowed' | 'denied';

export function Entries({ gymId, isOwner }: { gymId: number; isOwner: boolean }) {
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [rangeKey, setRangeKey] = useState<RangeKey>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [result, setResult] = useState<ResultFilter>('all');

  const [rows, setRows] = useState<Entry[]>([]);
  const [summary, setSummary] = useState<EntrySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const requestId = useRef(0); // eski bir yanıtın yenisini ezmesini önler

  const bounds = useMemo(() => computeBounds(rangeKey, customFrom, customTo), [rangeKey, customFrom, customTo]);
  const validBounds = isBounds(bounds) ? bounds : null;
  const todayKey = dayKey(new Date());

  const query = useCallback(
    (extra: Record<string, string | number>) => {
      // Her çağrıda taze hesaplanır; sayfa gece yarısını aşsa bile "Bugün" doğru kalır
      const b = computeBounds(rangeKey, customFrom, customTo);
      if (!isBounds(b)) return null;
      return new URLSearchParams({ from: b.from.toISOString(), to: b.to.toISOString(), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString();
    },
    [rangeKey, customFrom, customTo],
  );

  const loadFirst = useCallback(
    async (silent: boolean) => {
      const entriesQuery = query({ limit: PAGE_SIZE, offset: 0, result });
      const summaryQuery = query({ tzOffsetMinutes: tzOffsetMinutes() });
      const id = ++requestId.current;
      if (!entriesQuery || !summaryQuery) {
        setRows([]);
        setSummary(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const [page, sum] = await Promise.all([
          api.get<Entry[]>(`/api/gyms/${gymId}/entries?${entriesQuery}`),
          api.get<EntrySummary>(`/api/gyms/${gymId}/entries/summary?${summaryQuery}`),
        ]);
        if (id !== requestId.current) return;
        setRows(page);
        setSummary(sum);
        setError(null);
        setUpdatedAt(new Date());
      } catch (err) {
        if (id === requestId.current) setError(err instanceof ApiError ? err.message : 'Kayıtlar yüklenemedi.');
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [gymId, query, result],
  );

  // Aralık veya filtre değişince baştan yükle
  useEffect(() => {
    void loadFirst(false);
  }, [loadFirst]);

  // Otomatik yenileme: "Daha fazla göster" ile ek sayfa açıldıysa liste kaymasın diye durur
  const extraPagesLoaded = rows.length > PAGE_SIZE;
  useEffect(() => {
    if (extraPagesLoaded) return;
    const timer = setInterval(() => void loadFirst(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadFirst, extraPagesLoaded]);

  async function loadMore() {
    const q = query({ limit: PAGE_SIZE, offset: rows.length, result });
    if (!q) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const page = await api.get<Entry[]>(`/api/gyms/${gymId}/entries?${q}`);
      if (id === requestId.current) setRows((prev) => [...prev, ...page]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Daha fazla kayıt yüklenemedi.');
    } finally {
      setLoadingMore(false);
    }
  }

  // Seçili aralığı ve sonuç filtresini Excel'de açılan CSV olarak indirir (yalnızca sahip)
  async function exportCsv() {
    const q = query({ result, tzOffsetMinutes: tzOffsetMinutes() });
    if (!q) return;
    setExporting(true);
    setExportNote(null);
    setError(null);
    try {
      const { blob, filename, rowCount } = await api.download(`/api/gyms/${gymId}/entries/export?${q}`);
      saveBlob(blob, filename);
      setExportNote(`${filename} indirildi (${rowCount} kayıt).`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'İndirilemedi.');
    } finally {
      setExporting(false);
    }
  }

  // Filtreye uyan toplam kayıt sayısı (özet sonuç filtresinden bağımsız hesaplanır)
  const matching = summary ? (result === 'allowed' ? summary.allowed : result === 'denied' ? summary.denied : summary.total) : 0;
  const days = validBounds ? daysIn(validBounds) : [];
  const perDay = useMemo(() => {
    const byKey = new Map(summary?.byDay.map((d) => [d.day, d]) ?? []);
    return days.map((d) => ({ date: d, ...(byKey.get(dayKey(d)) ?? { allowed: 0, denied: 0 }) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, validBounds?.from.getTime(), validBounds?.to.getTime()]);
  const maxPerDay = Math.max(1, ...perDay.map((d) => d.allowed));

  return (
    <>
      <h1>Girişler</h1>

      <div className="chips" role="group" aria-label="Tarih aralığı">
        {RANGES.map((r) => (
          <button key={r.key} type="button" className="chip" aria-pressed={rangeKey === r.key} onClick={() => setRangeKey(r.key)}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="filters">
        {rangeKey === 'custom' && (
          <>
            <label className="field">
              <span className="field-label">Başlangıç</span>
              <input type="date" value={customFrom} max={todayKey} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Bitiş</span>
              <input type="date" value={customTo} min={customFrom || undefined} max={todayKey} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
          </>
        )}
        <label className="field">
          <span className="field-label">Sonuç</span>
          <select value={result} onChange={(e) => setResult(e.target.value as ResultFilter)}>
            <option value="all">Tümü</option>
            <option value="allowed">Geçenler</option>
            <option value="denied">Reddedilenler</option>
          </select>
        </label>
        {validBounds && (
          <p className="muted range-label">
            {formatDate(validBounds.from.toISOString())}
            {days.length > 1 && ` – ${formatDate(new Date(validBounds.to.getTime() - 1).toISOString())}`}
          </p>
        )}
        {isOwner && (
          <button
            type="button"
            className="btn export-btn"
            onClick={exportCsv}
            disabled={!validBounds || exporting || loading || matching === 0}
            title={matching === 0 && validBounds ? 'Bu aralıkta indirilecek kayıt yok' : 'Seçili aralığı Excel’de açılan CSV olarak indir'}
          >
            {exporting ? 'Hazırlanıyor…' : 'Excel’e aktar (CSV)'}
          </button>
        )}
      </div>

      {!validBounds && <p className="muted">{'error' in bounds ? bounds.error : ''}</p>}
      <ErrorNote message={error} />
      {exportNote && <p className="success" role="status">{exportNote}</p>}

      {validBounds && summary && (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-label">Geçen giriş</div><div className="stat-value">{summary.allowed}</div></div>
            <div className="stat"><div className="stat-label">Reddedilen</div><div className="stat-value">{summary.denied}</div></div>
            <div className="stat"><div className="stat-label">Farklı üye</div><div className="stat-value">{summary.uniqueMembers}</div><div className="stat-note">giriş yapan</div></div>
          </div>

          {days.length > 1 && (
            <section aria-label="Günlük dağılım">
              <h2>Gün gün</h2>
              <ul className="bars">
                {[...perDay].reverse().map((d) => (
                  <li key={dayKey(d.date)} className="bar-row">
                    <span className="bar-day">{d.date.toLocaleDateString('tr-TR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span>
                    <span className="bar-track" aria-hidden="true">
                      <span className="bar" style={{ width: `${(d.allowed / maxPerDay) * 100}%` }} />
                    </span>
                    <span className="bar-num">
                      {d.allowed} giriş{d.denied > 0 && <span className="bar-denied"> · {d.denied} red</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {validBounds && (
        <section aria-label="Kayıtlar">
          <h2>Kayıtlar</h2>
          {loading ? (
            <p className="muted">Yükleniyor…</p>
          ) : rows.length === 0 && !error ? (
            <p className="muted empty">Bu aralıkta {result === 'denied' ? 'reddedilen giriş' : result === 'allowed' ? 'geçen giriş' : 'giriş kaydı'} yok.</p>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Zaman</th>
                      <th>Üye</th>
                      <th>Kapı</th>
                      <th>Sonuç</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td>{formatDateTime(e.at)}</td>
                        <td>{e.memberName}</td>
                        <td>{e.gateName ?? e.gateId}</td>
                        <td>{e.allowed ? <Badge tone="ok">Geçti</Badge> : <Badge tone="bad">{REASON_TEXT[e.reason ?? ''] ?? 'Reddedildi'}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="list-foot">
                <span className="muted">
                  {matching} kayıttan {rows.length}’i gösteriliyor
                  {updatedAt && !extraPagesLoaded && ` · ${updatedAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} itibarıyla, otomatik yenilenir`}
                </span>
                {rows.length < matching && (
                  <button type="button" className="btn small" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? 'Yükleniyor…' : 'Daha fazla göster'}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
