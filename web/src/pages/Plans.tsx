import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { formatMoney, parseMoneyToCents } from '../format';
import { useLoad } from '../hooks';
import type { Plan } from '../types';
import { ErrorNote, Field, Modal, PageState } from '../ui';

export function Plans({ gymId, isOwner }: { gymId: number; isOwner: boolean }) {
  const plans = useLoad(() => api.get<Plan[]>(`/api/gyms/${gymId}/plans`), [gymId]);
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);

  return (
    <>
      <div className="page-head">
        <h1>Paketler</h1>
        {isOwner && <button className="btn primary" onClick={() => setEditing('new')}>+ Paket ekle</button>}
      </div>
      <p className="muted">
        {isOwner
          ? 'Fiyat veya süre değişikliği daha önce tanımlanmış üyelikleri etkilemez, yalnızca bundan sonra tanımlananları.'
          : 'Paketleri yalnızca salon sahibi düzenleyebilir.'}
      </p>
      <PageState loading={plans.loading} error={plans.error} empty={plans.data?.length === 0 && 'Henüz paket yok.'}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Paket</th>
                <th>Süre</th>
                <th>Fiyat</th>
                <th aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {plans.data?.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.days} gün</td>
                  <td>{p.priceCents === 0 ? <span className="muted">Fiyat girilmedi</span> : formatMoney(p.priceCents)}</td>
                  <td className="actions">
                    {isOwner && <button className="btn small" onClick={() => setEditing(p)}>Düzenle</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageState>

      {editing && (
        <PlanForm
          gymId={gymId}
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            plans.reload();
          }}
        />
      )}
    </>
  );
}

function PlanForm({ gymId, plan, onClose, onDone }: { gymId: number; plan: Plan | null; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const priceCents = parseMoneyToCents(String(form.get('price') ?? ''));
    if (priceCents === null) {
      setError('Fiyat geçerli bir sayı olmalı (örn. 1.250,50).');
      return;
    }
    const body = { name: String(form.get('name')).trim(), days: Number(form.get('days')), priceCents };
    setBusy(true);
    setError(null);
    try {
      if (plan) await api.patch(`/api/gyms/${gymId}/plans/${plan.id}`, body);
      else await api.post(`/api/gyms/${gymId}/plans`, body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kaydedilemedi.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={plan ? 'Paketi düzenle' : 'Yeni paket'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="Paket adı">
          <input name="name" required maxLength={100} defaultValue={plan?.name} autoFocus />
        </Field>
        <Field label="Süre (gün)">
          <input name="days" type="number" required min={1} max={3660} defaultValue={plan?.days ?? 30} />
        </Field>
        <Field label="Fiyat (₺)">
          <input
            name="price"
            inputMode="decimal"
            placeholder="0,00"
            defaultValue={plan && plan.priceCents > 0 ? (plan.priceCents / 100).toFixed(2).replace('.', ',') : ''}
          />
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button type="submit" className="btn primary" disabled={busy}>Kaydet</button>
        </div>
      </form>
    </Modal>
  );
}
