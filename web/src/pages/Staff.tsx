import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useLoad } from '../hooks';
import { ROLE_LABEL, type Role, type StaffMember } from '../types';
import { Badge, ConfirmModal, ErrorNote, Field, Modal, PageState } from '../ui';

export function Staff({ gymId, meId, onSelfChanged }: { gymId: number; meId: number; onSelfChanged: () => void }) {
  const staff = useLoad(() => api.get<StaffMember[]>(`/api/gyms/${gymId}/staff`), [gymId]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<StaffMember | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function changeRole(member: StaffMember, role: Role) {
    setActionError(null);
    try {
      await api.patch(`/api/gyms/${gymId}/staff/${member.userId}`, { role });
      if (member.userId === meId) onSelfChanged();
      else staff.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Rol değiştirilemedi.');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Çalışanlar</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Çalışan ekle</button>
      </div>
      <p className="muted">
        <strong>Sahip</strong> her şeyi yönetir. <strong>Çalışan</strong> üye ekleme, paket tanımlama, giriş kayıtlarını görme ve
        kapıyı elle açma gibi günlük işleri yapar; paket fiyatı, kapı, çalışan ve denetim kaydına erişemez.
      </p>
      <ErrorNote message={actionError} />
      <PageState loading={staff.loading} error={staff.error}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ad</th>
                <th>E-posta</th>
                <th>Rol</th>
                <th aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {staff.data?.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name}{m.userId === meId && <span className="sub"> (siz)</span>}</td>
                  <td>{m.email}</td>
                  <td><Badge tone={m.role === 'owner' ? 'ok' : 'muted'}>{ROLE_LABEL[m.role]}</Badge></td>
                  <td className="actions">
                    <button className="btn small" onClick={() => changeRole(m, m.role === 'owner' ? 'staff' : 'owner')}>
                      {m.role === 'owner' ? 'Çalışan yap' : 'Sahip yap'}
                    </button>
                    <button className="btn small ghost" onClick={() => setRemoving(m)}>Çıkar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageState>

      {adding && (
        <AddStaff
          gymId={gymId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            staff.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmModal
          title="Çalışanı çıkar"
          message={`${removing.name} artık bu salonun panelini kullanamayacak. Hesabı silinmez.`}
          confirmLabel="Çıkar"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await api.del(`/api/gyms/${gymId}/staff/${removing.userId}`);
            } catch (err) {
              throw new Error(err instanceof ApiError ? err.message : 'Çıkarılamadı.');
            }
            const self = removing.userId === meId;
            setRemoving(null);
            if (self) onSelfChanged();
            else staff.reload();
          }}
        />
      )}
    </>
  );
}

function AddStaff({ gymId, onClose, onDone }: { gymId: number; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const body: Record<string, string> = { email: text('email'), role: text('role') };
    if (text('name')) body.name = text('name');
    if (text('password')) body.password = String(form.get('password'));
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/gyms/${gymId}/staff`, body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Çalışan eklenemedi.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Çalışan ekle" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="E-posta" hint="Panele bu e-posta ile girecek.">
          <input name="email" type="email" required autoFocus />
        </Field>
        <Field label="Rol">
          <select name="role" defaultValue="staff">
            <option value="staff">Çalışan</option>
            <option value="owner">Sahip</option>
          </select>
        </Field>
        <Field label="Ad soyad">
          <input name="name" maxLength={100} />
        </Field>
        <Field label="İlk şifre" hint="En az 8 karakter. Bu e-posta sistemde zaten kayıtlıysa ad ve şifre gerekmez; kişi kendi şifresiyle girer.">
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
