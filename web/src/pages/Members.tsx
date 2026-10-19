import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { formatDate, formatMoney } from '../format';
import { useLoad } from '../hooks';
import type { Member, Plan } from '../types';
import { Badge, ErrorNote, Field, Modal, PageState } from '../ui';
import { MemberDetailModal } from './MemberDetail';

function status(m: Member) {
  if (!m.active) return <Badge tone="muted">Devre dışı</Badge>;
  if (m.hasActiveMembership) return <Badge tone="ok">Aktif</Badge>;
  return m.membershipEndsAt ? <Badge tone="bad">Süresi doldu</Badge> : <Badge tone="warn">Paket yok</Badge>;
}

export function Members({ gymId }: { gymId: number }) {
  const members = useLoad(() => api.get<Member[]>(`/api/gyms/${gymId}/members`), [gymId]);
  const plans = useLoad(() => api.get<Plan[]>(`/api/gyms/${gymId}/plans`), [gymId]);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState<Member | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0); // detay penceresini yeniletmek için
  const [actionError, setActionError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const rows = (members.data ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.includes(q));

  async function toggleActive(m: Member) {
    setActionError(null);
    try {
      await api.patch(`/api/gyms/${gymId}/members/${m.id}`, { active: !m.active });
      members.reload();
      setDetailRefresh((n) => n + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'İşlem yapılamadı.');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Üyeler</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Üye ekle</button>
      </div>
      <input
        className="search"
        type="search"
        placeholder="Ad veya e-posta ile ara…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Üye ara"
      />
      <ErrorNote message={actionError} />
      <PageState
        loading={members.loading}
        error={members.error}
        empty={rows.length === 0 && (members.data?.length ? 'Aramanızla eşleşen üye yok.' : 'Henüz üye yok. “Üye ekle” ile başlayın.')}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ad</th>
                <th>E-posta</th>
                <th>Durum</th>
                <th>Bitiş</th>
                <th>Son geliş</th>
                <th aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => setDetailId(m.id)} title="Detayı ve geldiği günleri gör">
                      {m.name}
                    </button>
                    {m.phone && <div className="sub">{m.phone}</div>}
                  </td>
                  <td>{m.email}</td>
                  <td>{status(m)}</td>
                  <td>{m.membershipEndsAt ? formatDate(m.membershipEndsAt) : '—'}</td>
                  <td>{m.lastVisitAt ? formatDate(m.lastVisitAt) : <span className="muted">Hiç gelmedi</span>}</td>
                  <td className="actions">
                    <button className="btn small" onClick={() => setAssigning(m)} disabled={!m.active}>Paket tanımla</button>
                    <button className="btn small ghost" onClick={() => toggleActive(m)}>
                      {m.active ? 'Devre dışı bırak' : 'Etkinleştir'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageState>

      {adding && (
        <AddMember
          gymId={gymId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            members.reload();
          }}
        />
      )}
      {detailId !== null && (
        <MemberDetailModal
          gymId={gymId}
          memberId={detailId}
          refreshKey={detailRefresh}
          onClose={() => setDetailId(null)}
          onAssign={() => setAssigning(members.data?.find((m) => m.id === detailId) ?? null)}
          onToggleActive={() => {
            const m = members.data?.find((x) => x.id === detailId);
            if (m) void toggleActive(m);
          }}
        />
      )}
      {/* Paket penceresi detaydan sonra çizilir: detay açıkken üstte görünür */}
      {assigning && (
        <AssignPlan
          gymId={gymId}
          member={assigning}
          plans={plans.data ?? []}
          onClose={() => setAssigning(null)}
          onDone={() => {
            setAssigning(null);
            members.reload();
            setDetailRefresh((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

function AddMember({ gymId, onClose, onDone }: { gymId: number; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const body: Record<string, string> = { email: text('email') };
    if (text('name')) body.name = text('name');
    if (text('phone')) body.phone = text('phone');
    if (text('password')) body.password = String(form.get('password'));
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/gyms/${gymId}/members`, body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Üye eklenemedi.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Üye ekle" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="E-posta" hint="Üye uygulamaya bu e-posta ile girecek.">
          <input name="email" type="email" required autoFocus />
        </Field>
        <Field label="Ad soyad">
          <input name="name" maxLength={100} />
        </Field>
        <Field label="Telefon">
          <input name="phone" type="tel" maxLength={30} />
        </Field>
        <Field label="İlk şifre" hint="En az 8 karakter. Bu e-posta başka bir salondan zaten kayıtlıysa ad ve şifre gerekmez; kişi salonunuza bağlanır.">
          <input name="password" type="text" minLength={8} autoComplete="off" />
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button type="submit" className="btn primary" disabled={busy}>Ekle</button>
        </div>
      </form>
    </Modal>
  );
}

function AssignPlan({
  gymId,
  member,
  plans,
  onClose,
  onDone,
}: {
  gymId: number;
  member: Member;
  plans: Plan[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [planId, setPlanId] = useState<number | null>(plans[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (planId === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/gyms/${gymId}/members/${member.id}/memberships`, { planId });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Paket tanımlanamadı.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Paket tanımla: ${member.name}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {plans.length === 0 ? (
          <p className="muted">Önce “Paketler” sayfasından bir paket ekleyin.</p>
        ) : (
          <fieldset className="choices">
            {plans.map((p) => (
              <label key={p.id} className={`choice${planId === p.id ? ' selected' : ''}`}>
                <input type="radio" name="plan" checked={planId === p.id} onChange={() => setPlanId(p.id)} />
                <span>
                  <strong>{p.name}</strong>
                  <span className="sub">{p.days} gün · {formatMoney(p.priceCents)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {member.hasActiveMembership && member.membershipEndsAt && (
          <p className="muted">
            Mevcut üyeliği {formatDate(member.membershipEndsAt)} tarihinde bitiyor; yeni paket bitişin ardından başlar.
          </p>
        )}
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button type="submit" className="btn primary" disabled={busy || planId === null}>Tanımla</button>
        </div>
      </form>
    </Modal>
  );
}
