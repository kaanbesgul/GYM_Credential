import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useLoad } from '../hooks';
import type { Gate, NewGate } from '../types';
import { Badge, ConfirmModal, ErrorNote, Field, Modal, PageState } from '../ui';

export function Gates({ gymId, isOwner }: { gymId: number; isOwner: boolean }) {
  const gates = useLoad(() => api.get<Gate[]>(`/api/gyms/${gymId}/gates`), [gymId], 10_000);
  const [adding, setAdding] = useState(false);
  const [shownKey, setShownKey] = useState<{ gate: NewGate; title: string } | null>(null);
  const [rotating, setRotating] = useState<Gate | null>(null);
  const [deleting, setDeleting] = useState<Gate | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function openGate(gate: Gate) {
    setNotice(null);
    try {
      await api.post(`/api/gyms/${gymId}/gates/${gate.id}/open`);
      setNotice({ tone: 'ok', text: `${gate.name} açıldı.` });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : 'Kapı açılamadı.' });
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Kapılar</h1>
        {isOwner && <button className="btn primary" onClick={() => setAdding(true)}>+ Kapı ekle</button>}
      </div>
      {notice && (notice.tone === 'ok' ? <p className="success" role="status">{notice.text}</p> : <ErrorNote message={notice.text} />)}
      <PageState
        loading={gates.loading}
        error={gates.error}
        empty={gates.data?.length === 0 && (isOwner ? 'Henüz kapı yok. “Kapı ekle” ile kapıdaki Raspberry Pi için bir anahtar oluşturun.' : 'Henüz kapı eklenmemiş.')}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kapı</th>
                <th>Durum</th>
                <th aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {gates.data?.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}<div className="sub mono">{g.id}</div></td>
                  <td>{g.online ? <Badge tone="ok">Çevrimiçi</Badge> : <Badge tone="muted">Çevrimdışı</Badge>}</td>
                  <td className="actions">
                    <button className="btn small" disabled={!g.online} onClick={() => openGate(g)}>Elle aç</button>
                    {isOwner && <button className="btn small ghost" onClick={() => setRotating(g)}>Anahtarı yenile</button>}
                    {isOwner && <button className="btn small ghost" onClick={() => setDeleting(g)}>Sil</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageState>

      {adding && (
        <AddGate
          gymId={gymId}
          onClose={() => setAdding(false)}
          onCreated={(g) => {
            setAdding(false);
            setShownKey({ gate: g, title: `${g.name} oluşturuldu` });
            gates.reload();
          }}
        />
      )}
      {rotating && (
        <ConfirmModal
          title="Kapı anahtarını yenile"
          message={`${rotating.name} için yeni bir anahtar üretilecek. Kapıdaki cihazın bağlantısı hemen kesilir ve yeni anahtar girilene kadar çalışmaz. Cihaz çalındıysa veya anahtar sızdıysa bunu yapın.`}
          confirmLabel="Anahtarı yenile"
          danger
          onClose={() => setRotating(null)}
          onConfirm={async () => {
            try {
              const g = await api.post<NewGate>(`/api/gyms/${gymId}/gates/${rotating.id}/rotate-key`);
              setRotating(null);
              setShownKey({ gate: g, title: `${g.name}: yeni anahtar` });
              gates.reload();
            } catch (err) {
              throw new Error(err instanceof ApiError ? err.message : 'Anahtar yenilenemedi.');
            }
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Kapıyı sil"
          message={`${deleting.name} silinecek ve cihazın bağlantısı kesilecek. Giriş kayıtları saklanır ama kapı adı yerine kimliği görünür. Bu işlem geri alınamaz.`}
          confirmLabel="Sil"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.del(`/api/gyms/${gymId}/gates/${deleting.id}`);
              setDeleting(null);
              gates.reload();
            } catch (err) {
              throw new Error(err instanceof ApiError ? err.message : 'Kapı silinemedi.');
            }
          }}
        />
      )}
      {shownKey && <GateKey gate={shownKey.gate} title={shownKey.title} onClose={() => setShownKey(null)} />}
    </>
  );
}

function AddGate({ gymId, onClose, onCreated }: { gymId: number; onClose: () => void; onCreated: (g: NewGate) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.post<NewGate>(`/api/gyms/${gymId}/gates`, { name }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kapı eklenemedi.');
      setBusy(false);
    }
  }

  return (
    <Modal title="Kapı ekle" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="Kapı adı" hint="Örn. Ana giriş, Kadınlar girişi">
          <input name="name" required maxLength={100} autoFocus />
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button type="submit" className="btn primary" disabled={busy}>Oluştur</button>
        </div>
      </form>
    </Modal>
  );
}

function GateKey({ gate, title, onClose }: { gate: NewGate; title: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const serverUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/gate`;
  const config = JSON.stringify(
    { server_url: serverUrl, gate_id: gate.id, gate_key: gate.key, fullscreen: true, relay: { mode: 'gpio', pin: 17, active_high: false, open_seconds: 3 } },
    null,
    2,
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
    } catch {
      setCopied(false); // pano izni yoksa kullanıcı metni elle seçip kopyalar
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <p className="warning-note">
          Kapı anahtarı yalnızca <strong>şimdi</strong> gösterilir, sonra tekrar görüntülenemez. Aşağıdaki ayarı kapıdaki
          Raspberry Pi'de <code>gate/config.json</code> dosyasına yapıştırın.
        </p>
        <pre className="code" tabIndex={0}>{config}</pre>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={copy}>{copied ? 'Kopyalandı ✓' : 'Ayarı kopyala'}</button>
          <button type="button" className="btn primary" onClick={onClose}>Kaydettim, kapat</button>
        </div>
      </div>
    </Modal>
  );
}
