// Excel'in (özellikle Türkçe bölgesel ayarlı) sorunsuz açtığı CSV: UTF-8 + BOM, ayırıcı noktalı virgül.

// Excel bu karakterlerle başlayan hücreleri formül sayar (CSV enjeksiyonu). Başına ' koyarak metne çeviririz.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** `header` bir satır, `rows` satır dizisi. Excel'in Türkçe karakterleri doğru okuması için BOM ile başlar. */
export function toCsv(header, rows) {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

const pad = (n) => String(n).padStart(2, '0');

/** Bir anı, UTC'ye `offsetMinutes` farklı yerel saatle böler (Türkiye için 180). */
export function localParts(iso, offsetMinutes) {
  const d = new Date(Date.parse(iso) + offsetMinutes * 60_000);
  const [y, m, day] = [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())];
  return {
    date: `${day}.${m}.${y}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    key: `${y}-${m}-${day}`,
  };
}

export const REASON_TEXT = {
  no_active_membership: 'Aktif üyelik yok',
  member_disabled: 'Üyelik devre dışı',
  not_a_member: 'Bu salonun üyesi değil',
  recent_entry: 'Art arda giriş denemesi',
  gate_offline: 'Kapı yanıt vermedi',
};
