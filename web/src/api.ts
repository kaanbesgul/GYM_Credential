const TOKEN_KEY = 'gym_enter_token';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // gizli pencere / depolama kapalı: oturum yalnızca bellekte tutulur
  }
}

let memoryToken: string | null = null;

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* depolama yoksa bellekteki değer yeterli */
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = memoryToken ?? getToken();
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    // Giriş denemesindeki 401 "şifre hatalı"dır; oturum düşmesi yalnızca token varken anlamlıdır
    if (res.status === 401 && token) onUnauthorized?.();
    if (data?.code === 'FST_ERR_VALIDATION') {
      throw new ApiError('Girilen bilgiler geçersiz, alanları kontrol edin.', res.status);
    }
    throw new ApiError(data?.error && data.error !== 'Bad Request' ? data.error : 'İstek başarısız oldu.', res.status);
  }
  return data as T;
}

/** Oturum anahtarı gerektiren bir dosyayı indirir (düz bağlantı Authorization başlığı gönderemez). */
async function download(path: string): Promise<{ blob: Blob; filename: string; rowCount: number }> {
  const token = memoryToken ?? getToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401 && token) onUnauthorized?.();
    if (data?.code === 'FST_ERR_VALIDATION') throw new ApiError('Girilen bilgiler geçersiz, alanları kontrol edin.', res.status);
    throw new ApiError(data?.error && data.error !== 'Bad Request' ? data.error : 'İndirilemedi.', res.status);
  }
  const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'indirme.csv';
  return { blob: await res.blob(), filename, rowCount: Number(res.headers.get('x-row-count') ?? 0) };
}

/** Bellekteki dosyayı tarayıcının indirme akışına verir. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const api = {
  download,
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
