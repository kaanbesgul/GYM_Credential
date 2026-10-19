import { api } from '../api';
import { describeAudit, formatDateTime } from '../format';
import { useLoad } from '../hooks';
import type { AuditEntry } from '../types';
import { PageState } from '../ui';

export function Audit({ gymId }: { gymId: number }) {
  const log = useLoad(() => api.get<AuditEntry[]>(`/api/gyms/${gymId}/audit?limit=200`), [gymId], 15_000);

  return (
    <>
      <h1>Denetim kaydı</h1>
      <p className="muted">Salonda kimin ne zaman hangi değişikliği yaptığını gösterir. Son 200 kayıt.</p>
      <PageState loading={log.loading} error={log.error} empty={log.data?.length === 0 && 'Henüz kayıtlı bir işlem yok.'}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zaman</th>
                <th>Kim</th>
                <th>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {log.data?.map((e) => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.at)}</td>
                  <td>{e.actorName}</td>
                  <td>{describeAudit(e.action, e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageState>
    </>
  );
}
