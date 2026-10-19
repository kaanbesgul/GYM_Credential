// Giriş kayıtları için tarih aralığı hesapları. Gün sınırları kullanıcının KENDİ saat diliminde
// hesaplanır ve sunucuya anlık zaman (ISO) olarak gönderilir. Bitiş her zaman "hariç"tir.

export type RangeKey = 'today' | 'yesterday' | 'week' | 'last7' | 'month' | 'custom';

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Bugün' },
  { key: 'yesterday', label: 'Dün' },
  { key: 'week', label: 'Bu hafta' },
  { key: 'last7', label: 'Son 7 gün' },
  { key: 'month', label: 'Bu ay' },
  { key: 'custom', label: 'Özel aralık' },
];

export interface Bounds {
  from: Date;
  to: Date; // hariç
}

const MAX_CUSTOM_DAYS = 366;

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** "2026-03-10" (tarih girişinin değeri) -> yerel gün başlangıcı */
export function parseDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Yerel tarihi "2026-03-10" biçiminde verir (sunucudaki gün anahtarlarıyla aynı). */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const isBounds = (x: Bounds | { error: string }): x is Bounds => 'from' in x;

export function computeBounds(key: RangeKey, customFrom: string, customTo: string, now = new Date()): Bounds | { error: string } {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  let from: Date;
  let to: Date;

  switch (key) {
    case 'today':
      from = today;
      to = tomorrow;
      break;
    case 'yesterday':
      from = addDays(today, -1);
      to = today;
      break;
    case 'week': {
      const sinceMonday = (today.getDay() + 6) % 7; // hafta pazartesi başlar
      from = addDays(today, -sinceMonday);
      to = addDays(from, 7);
      break;
    }
    case 'last7':
      from = addDays(today, -6);
      to = tomorrow;
      break;
    case 'month':
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      to = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      break;
    case 'custom': {
      if (!customFrom || !customTo) return { error: 'Başlangıç ve bitiş tarihini seçin.' };
      from = parseDay(customFrom);
      to = addDays(parseDay(customTo), 1);
      if (to <= from) return { error: 'Bitiş tarihi başlangıçtan önce olamaz.' };
      if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_CUSTOM_DAYS) return { error: 'En fazla 1 yıllık aralık seçilebilir.' };
      break;
    }
  }

  // Gelecekte kayıt olamaz; hafta/ay gibi aralıkların gelecek günleri gösterilmez
  if (to > tomorrow) to = tomorrow;
  if (from >= to) return { error: 'Gelecekteki bir tarih seçilemez.' };
  return { from, to };
}

/** Aralıktaki her günün yerel başlangıcı (en eski önce). */
export function daysIn({ from, to }: Bounds): Date[] {
  const days: Date[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Sunucuya gidecek UTC farkı (dakika). Türkiye için 180. */
export const tzOffsetMinutes = () => -new Date().getTimezoneOffset();
