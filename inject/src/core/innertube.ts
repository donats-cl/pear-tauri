/**
 * Запросы к InnerTube (внутреннему API YouTube) — так же, как их делает сама
 * страница YouTube Music: с её контекстом, ключом и авторизацией аккаунта.
 */

type YtCfg = { get?: (key: string) => unknown; data_?: Record<string, unknown> };

export const ytcfg = (key: string): any => {
  const cfg = (window as unknown as { ytcfg?: YtCfg }).ytcfg;
  return cfg?.get?.(key) ?? cfg?.data_?.[key];
};

export const isLoggedIn = () => ytcfg('LOGGED_IN') !== false;

/** Мобильный клиент: некоторые данные (например, текст с таймкодами) отдаются только ему */
export const ANDROID_MUSIC = { clientName: 'ANDROID_MUSIC', clientVersion: '7.27.52', id: '21' };

// Авторизация как у веб-клиента YouTube: SAPISIDHASH от cookie SAPISID
async function sapisidHash(): Promise<string | null> {
  const m = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
  if (!m || !crypto.subtle) return null;
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${m[1]} ${location.origin}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
}

/**
 * POST /youtubei/v1/<endpoint>. По умолчанию — от имени веб-клиента страницы
 * (WEB_REMIX); `client` подменяет его, например на ANDROID_MUSIC.
 */
export async function innertube(
  endpoint: string,
  body: Record<string, unknown>,
  client?: { clientName: string; clientVersion: string; id: string },
): Promise<any> {
  const base = ytcfg('INNERTUBE_CONTEXT');
  if (!base?.client) throw new Error('страница ещё не готова');
  const context = client
    ? { ...base, client: { ...base.client, clientName: client.clientName, clientVersion: client.clientVersion } }
    : base;
  const key = ytcfg('INNERTUBE_API_KEY');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Youtube-Client-Name': client?.id ?? '67', // 67 — WEB_REMIX
    'X-Youtube-Client-Version': context.client.clientVersion,
    'X-Goog-AuthUser': String(ytcfg('SESSION_INDEX') ?? 0),
    'X-Origin': location.origin,
  };
  const visitor = ytcfg('VISITOR_DATA');
  if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
  const auth = await sapisidHash();
  if (auth) headers.Authorization = auth;

  const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ context, ...body }),
    credentials: 'include',
  });
  if (res.status === 401 || res.status === 403) throw new Error('нужно войти в аккаунт YouTube Music');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ *
 *  Поиск в ответах (структура ответов глубокая и меняется)
 * ------------------------------------------------------------------ */
export function findDeep(o: unknown, pred: (x: any) => boolean, depth = 0): any {
  if (!o || typeof o !== 'object' || depth > 40) return null;
  if (pred(o)) return o;
  for (const v of Object.values(o)) {
    const r = findDeep(v, pred, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Все значения по ключу `key` на любой глубине */
export function collect(o: unknown, key: string, out: any[] = [], depth = 0): any[] {
  if (!o || typeof o !== 'object' || depth > 40) return out;
  for (const [k, v] of Object.entries(o)) {
    if (k === key) out.push(v);
    else collect(v, key, out, depth + 1);
  }
  return out;
}

export const runsText = (x: any): string => x?.runs?.map((r: any) => r.text).join('') ?? '';
