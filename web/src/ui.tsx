import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' wide' : ''}`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // arka plana tıklayınca kapanır
      }}
    >
      <div className="modal-body">
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Kapat" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/** Geri alınamaz işlemler için onay penceresi. */
export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'İşlem yapılamadı.');
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <p>{message}</p>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Vazgeç</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={confirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorNote({ message }: { message: string | null }) {
  return message ? <p className="error" role="alert">{message}</p> : null;
}

export function PageState({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty?: string | false;
  children: ReactNode;
}) {
  if (loading) return <p className="muted">Yükleniyor…</p>;
  if (error) return <ErrorNote message={error} />;
  if (empty) return <p className="muted empty">{empty}</p>;
  return <>{children}</>;
}
