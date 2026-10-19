const dateFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const moneyFmt =new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });

export const formatDate = (iso: string) => dateFmt.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatMoney = (cents: number) => moneyFmt.format(cents / 100);

/** "1.250,50" gibi girilen tutarı kuruşa çevirir; geçersizse null. */
export function parseMoneyToCents(input: string): number | null {
  const normalized = input.trim().replace(/\./g, '').replace(',', '.');
  if (normalized === '') return 0;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

/** Denetim kaydı satırını okunur bir cümleye çevirir. */
export function describeAudit(action: string, details: Record<string, unknown> | null): string {
  const d = details ?? {};
  const name = typeof d.name === 'string' ? d.name : '';
  const role = (r: unknown) => (r === 'owner' ? 'Sahip' : 'Çalışan');
  switch (action) {
    case 'member.add': return `Üye ekledi: ${name}`;
    case 'member.enable': return `Üyeyi etkinleştirdi: ${name}`;
    case 'member.disable': return `Üyeyi devre dışı bıraktı: ${name}`;
    case 'membership.assign': return `Paket tanımladı: ${name} (${String(d.plan ?? '')})`;
    case 'plan.create': return `Paket oluşturdu: ${name}`;
    case 'plan.update': return `Paketi güncelledi: ${name}`;
    case 'gate.create': return `Kapı ekledi: ${name}`;
    case 'gate.rotate_key': return `Kapı anahtarını yeniledi: ${name}`;
    case 'gate.delete': return `Kapıyı sildi: ${name}`;
    case 'gate.open': return `Kapıyı elle açtı: ${name}`;
    case 'staff.add': return `Çalışan ekledi: ${name} (${role(d.role)})`;
    case 'staff.role': return `Rolü değiştirdi: ${name} (${role(d.from)} → ${role(d.to)})`;
    case 'staff.remove': return `Çalışanı çıkardı: ${name}`;
    case 'gym.create': return 'Salonu oluşturdu';
    case 'entries.export': return `Giriş kayıtlarını indirdi: ${String(d.from ?? '')} – ${String(d.to ?? '')} (${String(d.count ?? 0)} kayıt)`;
    default: return action;
  }
}

export const REASON_TEXT: Record<string, string> = {
  no_active_membership: 'Aktif üyelik yok',
  member_disabled: 'Üyelik devre dışı',
  not_a_member: 'Bu salonun üyesi değil',
  recent_entry: 'Art arda giriş denemesi',
  gate_offline: 'Kapı yanıt vermedi',
};
