/**
 * Lyrics — тексты песен (YouTube, LRCLib, Genius) во вкладке «ТЕКСТ» плеера.
 * Источник выбирается в меню; если в выбранном текста нет, показывается следующий.
 * Порт логики из userscript Pear Lite для Tauri: без GM_*, сеть через Rust-команду.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initLyrics } from './features/lyrics';
 *   const lyrics = initLyrics();
 *   // lyrics.setConfig({ fontSize: 24 });
 *   // lyrics.openTab();
 *   // lyrics.destroy();
 *
 * Сеть: по умолчанию вызывается Rust-команда `http_get` (src-tauri/src/lyrics_cmd.rs).
 * Можно подменить через options.httpGet.
 */

import {
  clamp,
  createStyle,
  getVideo,
  h,
  invoke,
  isTopFrame,
  loadConfig,
  readTrack,
  saveConfig,
  svgIcon,
  whenRootReady,
  type Track,
} from '../core';
import { ANDROID_MUSIC, collect, innertube, runsText } from '../core/innertube';
import { QUALITY_MENU_CSS } from '../core/quality';

export interface LyricsConfig {
  /** Включён ли плагин (подмена родной вкладки «Текст») */
  enabled: boolean;
  /** Сдвиг текста, мс (+ = текст раньше) */
  offset: number;
  /** Размер шрифта, px */
  fontSize: number;
  /** Приоритетный источник текста (остальные — запасные, по порядку SOURCES) */
  source: Source;
}

/** YouTube — родной текст YouTube Music (обычно от Musixmatch) */
export type Source = 'YouTube' | 'LRCLib' | 'Genius';

/** Все источники; порядок — порядок запасных */
const SOURCES: Source[] = ['YouTube', 'LRCLib', 'Genius'];

const svgCheck = () => svgIcon('M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z');

export interface HttpResp {
  status: number;
  body: string;
}
export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<HttpResp>;

export interface LyricsOptions {
  config?: Partial<LyricsConfig>;
  /** Свой GET-загрузчик (по умолчанию — Rust-команда `http_get`) */
  httpGet?: HttpGet;
}

export interface LyricsController {
  getConfig(): LyricsConfig;
  setConfig(patch: Partial<LyricsConfig>): void;
  /** Открыть плеер и вкладку «Текст» */
  openTab(): void;
  destroy(): void;
}

interface LrcLine {
  t: number;
  text: string;
}
interface LyricsResult {
  source: Source;
  synced: LrcLine[] | null;
  plain: string | null;
}
interface Candidate {
  title: string;
  artist: string;
  path: string;
}
interface Report {
  lines: string[];
  candidates: Candidate[];
}

const STORAGE_KEY = 'pear:lyrics';
const HEAD_SELECTOR = '#tabsContent > .tab-header:nth-of-type(2)';
const TAB_RENDERER_SELECTOR = '#tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]';

const DEFAULT_CONFIG: LyricsConfig = {
  enabled: true,
  offset: 0,
  fontSize: 20,
  source: 'LRCLib',
};

const DEBUG = false;
const glog = (...args: unknown[]) => {
  if (DEBUG) console.log('[Pear][Lyrics]', ...args);
};

/* ------------------------------------------------------------------ *
 *  Сеть (Rust-команда)
 * ------------------------------------------------------------------ */
const tauriHttpGet: HttpGet = (url, headers) => invoke<HttpResp>('http_get', { url, headers: headers ?? null });

let httpGet: HttpGet = tauriHttpGet;

/* ------------------------------------------------------------------ *
 *  Утилиты
 * ------------------------------------------------------------------ */
const trackKey = (t: Track) => `${t.title}|${t.artist}|${t.art}`;

function normalize(config: LyricsConfig): void {
  config.fontSize = clamp(config.fontSize, 12, 40);
  if (!SOURCES.includes(config.source)) config.source = DEFAULT_CONFIG.source;
}

const noopController: LyricsController = {
  getConfig: () => ({ ...DEFAULT_CONFIG }),
  setConfig: () => {},
  openTab: () => {},
  destroy: () => {},
};

/* ================================================================== *
 *  Поиск текстов (без зависимостей от DOM)
 * ================================================================== */

/* ------------------------------------------------------------------ *
 *  LRC-парсер
 * ------------------------------------------------------------------ */
function parseLRC(text: string): LrcLine[] {
  const lines: LrcLine[] = [];
  let offset = 0;
  // sticky: метки читаются только подряд с начала строки, "[1:23]" внутри текста — не метка
  const stampRe = /\[(\d+):(\d+)(?:[.:](\d+))?\]/y;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('[')) continue;

    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    let pos = 0;
    stampRe.lastIndex = 0;
    while ((m = stampRe.exec(line)) !== null) {
      pos = stampRe.lastIndex;
      const ms = (m[3] || '0').padEnd(3, '0').slice(0, 3);
      stamps.push(parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + parseInt(ms, 10));
    }

    if (!stamps.length) {
      const tag = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
      if (tag) offset = parseInt(tag[1], 10);
      continue;
    }

    const body = line
      .slice(pos)
      .replace(/<\d+:\d+(?:[.:]\d+)?>/g, '')
      .trim();
    for (const t of stamps) lines.push({ t, text: body });
  }

  lines.sort((a, b) => a.t - b.t);
  // по спецификации LRC положительный offset — текст появляется раньше
  if (offset) for (const l of lines) l.t = Math.max(0, l.t - offset);
  return lines;
}

/* ------------------------------------------------------------------ *
 *  Сопоставление исполнителей / названий
 * ------------------------------------------------------------------ */
const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const splitArtists = (s: string) =>
  (s || '')
    .split(/[&,]|\bfeat\.?\b|\bft\.?\b/i)
    .map(norm)
    .filter(Boolean);

const artistMatch = (a: string, b: string) => {
  const A = splitArtists(a);
  const B = splitArtists(b);
  return A.some((x) =>
    B.some((y) => x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)))),
  );
};

// "Song (feat. X) - Remastered 2011" -> "song"
const coreTitle = (s: string) => norm((s || '').replace(/\(.*?\)|\[.*?\]|\s[-–—]\s.*$/g, ''));
const titleMatch = (a: string, b: string) => {
  const x = coreTitle(a);
  const y = coreTitle(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

const wordOverlap = (a: string, b: string) => {
  const A = new Set(coreTitle(a).split(' ').filter(Boolean));
  const B = new Set(coreTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};

// кириллица, греческий, арабский, иврит, индийские, CJK, хангыль и т.п.
const hasNonLatin = (s: string) => /[\u0370-\u1fff\u2e80-\u9fff\uac00-\ud7af]/.test(s || '');

/* ------------------------------------------------------------------ *
 *  Очистка названия: "Henry Morris - Song (Official Audio)" -> "Song"
 * ------------------------------------------------------------------ */
const JUNK_IN_BRACKETS =
  /\s*[(\[{][^)\]}]*?\b(?:official|audio|video|lyrics?|lyric video|visuali[sz]er|music video|mv|hd|hq|4k|explicit|clip|premiere|full album|topic)\b[^)\]}]*[)\]}]/gi;
const JUNK_TRAILING =
  /\s*[|\-–—]\s*(?:official\s*(?:music\s*)?(?:audio|video|lyric video)|lyrics?|audio|visuali[sz]er)\s*$/i;

function cleanTrack(track: Track): Track {
  let title = (track.title || '').replace(JUNK_IN_BRACKETS, '').replace(JUNK_TRAILING, '').trim();

  const parts = title.split(/\s+[-–—|]\s+/);
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts[parts.length - 1];
    if (artistMatch(left, track.artist)) title = parts.slice(1).join(' - ');
    else if (artistMatch(right, track.artist)) title = parts.slice(0, -1).join(' - ');
  }

  title = title.replace(/\s{2,}/g, ' ').trim() || track.title;
  return { ...track, title };
}

/* ------------------------------------------------------------------ *
 *  LRCLib
 * ------------------------------------------------------------------ */
interface LrclibItem {
  instrumental?: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  artistName: string;
  duration: number;
}

async function lrclibJSON<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = `https://lrclib.net/api/${path}?${new URLSearchParams(params)}`;
  const res = await httpGet(url, { Accept: 'application/json' });
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new Error(`LRCLib: HTTP ${res.status}`);
  return JSON.parse(res.body) as T;
}

function lrclibToResult(item: LrclibItem | null): LyricsResult | null {
  if (!item || item.instrumental) return null;
  const synced = item.syncedLyrics ? parseLRC(item.syncedLyrics) : null;
  const plain = item.plainLyrics || null;
  if ((!synced || !synced.length) && !plain) return null;
  return { source: 'LRCLib', synced: synced && synced.length ? synced : null, plain };
}

function lrclibPickBest(list: LrclibItem[] | null, track: Track, duration: number): LrclibItem | null {
  if (!Array.isArray(list)) return null;
  const ok = list
    .filter((it) => artistMatch(track.artist, it.artistName))
    .filter((it) => !duration || Math.abs(it.duration - duration) <= 15)
    .filter((it) => it.syncedLyrics || it.plainLyrics);
  ok.sort((a, b) => {
    const da = duration ? Math.abs(a.duration - duration) : 0;
    const db = duration ? Math.abs(b.duration - duration) : 0;
    if (da !== db) return da - db;
    return (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0);
  });
  return ok[0] || null;
}

async function fetchFromLRCLib(
  track: Track,
  durationP: Promise<number>,
  report: Report,
): Promise<LyricsResult | null> {
  const note = (s: string) => report.lines.push(s);
  // ошибка одного шага не должна отменять остальные
  const attempt = async (label: string, fn: () => Promise<LyricsResult | null>) => {
    try {
      return await fn();
    } catch (e) {
      note(`LRCLib ${label}: ошибка (${(e as Error).message})`);
      return null;
    }
  };
  const search = (label: string, params: Record<string, string>, dur: number) =>
    attempt(label, async () => {
      const list = await lrclibJSON<LrclibItem[]>('search', params);
      const best = lrclibPickBest(list, track, dur);
      note(`LRCLib ${label}: ${Array.isArray(list) ? list.length : 0} рез., подходящий: ${best ? 'да' : 'нет'}`);
      return best ? lrclibToResult(best) : null;
    });

  // длительность нужна и для /get, и для отбора результатов поиска
  const duration = await durationP;
  const dur = duration ? Math.round(duration) : 0;
  note(`Длительность трека: ${dur ? dur + ' c' : 'неизвестна'}`);

  // Все три запроса уходят сразу, а результат берётся по приоритету:
  // 1) точное совпадение, 2) поиск по названию и исполнителю, 3) свободный поиск
  const getParams: Record<string, string> = { track_name: track.title, artist_name: track.artist };
  if (track.album) getParams.album_name = track.album;
  if (dur) getParams.duration = String(dur);
  const steps = [
    attempt('/get', async () => {
      const r = lrclibToResult(await lrclibJSON<LrclibItem>('get', getParams));
      note(`LRCLib /get: ${r ? 'найдено' : 'нет'}`);
      return r;
    }),
    search('/search', { track_name: track.title, artist_name: track.artist }, dur),
    search('/search?q', { q: `${track.title} ${track.artist}`.trim() }, dur),
  ];
  for (const step of steps) {
    const r = await step;
    if (r) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Genius
 * ------------------------------------------------------------------ */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    e = e.toLowerCase();
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] || m;
  });

// Достаёт текст из HTML страницы Genius без DOMParser (Trusted Types)
function extractGeniusLyrics(html: string): string | null {
  const parts: string[] = [];
  // только сами блоки текста: класс именно Lyrics__Container, а не LyricsHeader__Container,
  // LyricsFooter__Container («Embed») или LyricsEditExplainer__Container («How to Format Lyrics»)
  const startRe =
    /<div[^>]*(?:data-lyrics-container\s*=\s*["']true["']|class\s*=\s*["'](?:[^"']*\s)?Lyrics__Container[^"']*["'])[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(html)) !== null) {
    const tagRe = /<(\/?)(div|br)\b([^>]*)>/gi;
    tagRe.lastIndex = m.index + m[0].length;
    let last = tagRe.lastIndex;
    let depth = 1;
    let skipDepth = 0;
    let buf = '';
    let t: RegExpExecArray | null;
    while (depth > 0 && (t = tagRe.exec(html)) !== null) {
      if (!skipDepth) buf += html.slice(last, t.index);
      last = tagRe.lastIndex;

      const closing = t[1] === '/';
      const name = t[2].toLowerCase();
      if (name === 'br') {
        if (!skipDepth) buf += '\n';
        continue;
      }
      if (closing) {
        if (skipDepth && depth === skipDepth) skipDepth = 0;
        depth--;
      } else {
        depth++;
        if (!skipDepth && /data-exclude-from-selection\s*=\s*"true"/.test(t[3])) skipDepth = depth;
      }
    }
    parts.push(buf);
    startRe.lastIndex = Math.max(startRe.lastIndex, last);
  }

  if (!parts.length) return null;
  const text = stripGeniusJunk(decodeEntities(parts.join('\n').replace(/<[^>]+>/g, '')))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

// Страховка на случай, если Genius снова поменяет разметку: служебные
// надписи страницы, которые не относятся к тексту песни
function stripGeniusJunk(text: string): string {
  return (
    text
      // подсказка редакторам: «How to Format Lyrics: … transcribers forum»
      .replace(/How to Format Lyrics:[\s\S]*?transcribers forum/gi, '')
      // шапка «12 Contributors…Song Lyrics» перед первой строкой
      .replace(/^\s*\d+\s*Contributors?[^\n]*?Lyrics/i, '')
      // кнопка «Embed» в конце (бывает с числом: «123Embed»)
      .replace(/\s*\d*\s*Embed\s*$/i, '')
      // хвост «You might also like» посреди текста
      .replace(/^You might also like$/gim, '')
  );
}

interface GeniusHit {
  id: number;
  path?: string;
  title: string;
  full_title?: string;
  url?: string;
  artist_names?: string;
  primary_artist?: { name?: string; url?: string };
}

async function geniusSearch(url: string): Promise<GeniusHit[]> {
  const res = await httpGet(url, { Accept: 'application/json' });
  glog('поиск', res.status, url);
  if (res.status < 200 || res.status >= 300) throw new Error(`Genius: HTTP ${res.status}`);
  const data = JSON.parse(res.body);
  return ((data.response?.sections as any[]) || [])
    .flatMap((s) => (s.hits || []).filter((x: any) => !x.type || x.type === 'song').map((x: any) => x.result))
    .filter(Boolean);
}

interface TraceItem {
  r: GeniusHit;
  tm: boolean;
  am: boolean;
  score: number;
}

function pickGenius(cands: GeniusHit[], track: Track, trace: TraceItem[]): GeniusHit | null {
  let best: { score: number; r: GeniusHit } | null = null;
  for (const r of cands) {
    if (!r.path) continue;
    if (r.primary_artist && /Deleted-artist/i.test(r.primary_artist.url || '')) continue;

    const names = `${r.artist_names || ''} ${r.primary_artist?.name || ''}`;
    const tm = titleMatch(track.title, r.title);
    const exact = coreTitle(r.title) === coreTitle(track.title);
    const am = artistMatch(track.artist, names);
    // кириллица/иероглифы на YouTube Music, а на Genius латиница (или наоборот)
    const scriptDiffers = hasNonLatin(track.artist) !== hasNonLatin(names);
    const overlap = wordOverlap(track.title, r.title);

    let score = 0;
    if (tm && am) score = exact ? 4 : 3;
    else if (am && overlap >= 0.6) score = 2.5;
    else if (exact && scriptDiffers) score = 2;

    glog('кандидат', { title: r.title, artist: r.artist_names, tm, am, exact, scriptDiffers, overlap, score });
    trace.push({ r, tm, am, score });
    if (score && (!best || score > best.score)) best = { score, r };
  }
  return best ? best.r : null;
}

async function fetchGeniusPage(path: string): Promise<LyricsResult | null> {
  const page = await httpGet(`https://genius.com${path}`);
  glog('страница', page.status, path, `${page.body.length} байт`);
  if (page.status < 200 || page.status >= 300) throw new Error(`Genius: HTTP ${page.status}`);

  const lyrics = extractGeniusLyrics(page.body);
  if (!lyrics) {
    if (/lyricsPlaceholderReason.{1,5}unreleased/.test(page.body)) return null;
    throw new Error('Genius: страница получена, но текст не извлечён (возможно, изменилась разметка)');
  }
  if (lyrics.toLowerCase().replace(/[[\]\s]/g, '') === 'instrumental') return null;
  return { source: 'Genius', synced: null, plain: lyrics };
}

async function fetchFromGenius(track: Track, report: Report): Promise<LyricsResult | null> {
  const note = (s: string) => report.lines.push(s);
  const firstArtist = (track.artist || '').split(/[&,]/)[0].trim();
  const cleanTitle = (track.title || '').replace(/\(.*?\)|\[.*?\]|\s[-–—]\s.*$/g, '').trim() || track.title;
  const queries = [
    ...new Set([`${track.artist} ${track.title}`.trim(), `${firstArtist} ${cleanTitle}`.trim(), cleanTitle]),
  ];

  // Все варианты запроса (и запасной эндпоинт search/multi) уходят сразу;
  // кандидаты набираются в порядке приоритета запросов, как при поочерёдном поиске
  const searches: [string, string][] = [
    ...queries.map((q): [string, string] => [
      `search/song «${q}»`,
      `https://genius.com/api/search/song?${new URLSearchParams({ q, page: '1', per_page: '10' })}`,
    ]),
    ['search/multi', `https://genius.com/api/search/multi?${new URLSearchParams({ q: queries[0] })}`],
  ];
  const pending = searches.map(([label, url]) =>
    geniusSearch(url).then(
      (hits) => {
        note(`Genius ${label}: ${hits.length} рез.`);
        return hits;
      },
      (e: unknown) => {
        note(`Genius ${label}: ошибка (${(e as Error).message})`);
        return [] as GeniusHit[];
      },
    ),
  );

  let chosen: GeniusHit | null = null;
  const seen = new Map<number, GeniusHit>();
  let trace: TraceItem[] = [];
  for (const p of pending) {
    for (const r of await p) if (!seen.has(r.id)) seen.set(r.id, r);
    trace = [];
    chosen = pickGenius([...seen.values()], track, trace);
    if (chosen) break;
  }

  if (!chosen) {
    note('Genius: подходящего результата нет. Кандидаты:');
    for (const t of trace.slice(0, 6)) {
      note(`  • ${t.r.artist_names} — ${t.r.title}  [название ${t.tm ? '✓' : '✗'}, исполнитель ${t.am ? '✓' : '✗'}]`);
    }
    if (!trace.length) note('  (поиск ничего не вернул)');
    report.candidates = [...seen.values()]
      .filter((r) => r.path)
      .slice(0, 6)
      .map((r) => ({ title: r.title, artist: r.artist_names || '', path: r.path! }));
    return null;
  }

  note(`Genius: выбрано «${chosen.artist_names} — ${chosen.title}»`);
  const result = await fetchGeniusPage(chosen.path!);
  if (!result) note('Genius: страница без текста (не издана или инструментал)');
  return result;
}

/* ------------------------------------------------------------------ *
 *  YouTube: родной текст YouTube Music
 *  Вкладка «Текст» из ответа `next` → browse по её browseId.
 *  Мобильный клиент отдаёт текст построчно, у синхронизированных песен —
 *  с таймкодами (cueRange); веб-клиент — одним блоком без таймкодов.
 * ------------------------------------------------------------------ */
interface TimedLine {
  lyricLine?: string;
  cueRange?: { startTimeMilliseconds?: string | number };
}

async function fetchFromYouTube(videoId: string | null, report: Report): Promise<LyricsResult | null> {
  const note = (s: string) => report.lines.push(s);
  if (!videoId) {
    note('YouTube: не удалось определить videoId трека');
    return null;
  }

  const next = await innertube('next', { videoId });
  const tab = collect(next, 'tabRenderer').find(
    (t) =>
      t?.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ===
      'MUSIC_PAGE_TYPE_TRACK_LYRICS',
  );
  const browseId: string | undefined = tab?.endpoint?.browseEndpoint?.browseId;
  if (!browseId) {
    note('YouTube: у трека нет текста');
    return null;
  }

  try {
    const data = await innertube('browse', { browseId }, ANDROID_MUSIC);
    const lines: TimedLine[] | undefined = collect(data, 'timedLyricsData')[0];
    if (Array.isArray(lines) && lines.length) {
      const plain = lines.map((l) => l.lyricLine ?? '').join('\n').trim();
      const timed = lines.filter((l) => l.cueRange?.startTimeMilliseconds !== undefined);
      // синхронным считаем, только если таймкоды есть почти у всех строк
      const synced =
        timed.length && timed.length >= lines.length * 0.8
          ? timed
              .map((l) => ({ t: Number(l.cueRange!.startTimeMilliseconds) || 0, text: (l.lyricLine ?? '').trim() }))
              .sort((a, b) => a.t - b.t)
          : null;
      note(`YouTube: найдено${synced ? ', с синхронизацией' : ''}`);
      return { source: 'YouTube', synced, plain: plain || null };
    }
  } catch (e) {
    note(`YouTube (мобильный клиент): ошибка (${(e as Error).message})`);
  }

  // запасной путь — текст одним блоком, как во вкладке веб-версии
  const web = await innertube('browse', { browseId });
  const plain = runsText(collect(web, 'musicDescriptionShelfRenderer')[0]?.description).trim();
  note(`YouTube: ${plain ? 'найдено (без синхронизации)' : 'текста нет'}`);
  return plain ? { source: 'YouTube', synced: null, plain } : null;
}

/* ------------------------------------------------------------------ *
 *  Общий поиск: все источники параллельно
 *  results[src]: undefined — ещё ищем, null — не найдено, объект — найдено
 * ------------------------------------------------------------------ */
interface SearchState {
  raw: Track;
  results: Partial<Record<Source, LyricsResult | null>>;
  report: Report;
}

function searchLyrics(
  rawTrack: Track,
  videoId: string | null,
  durationP: Promise<number>,
  onUpdate: (state: SearchState) => void,
  preset: CachedResults = {},
): SearchState {
  const track = cleanTrack(rawTrack);
  const base: string[] = [];
  if (track.title !== rawTrack.title) base.push(`Название очищено: «${rawTrack.title}» → «${track.title}»`);

  const ytRep: Report = { lines: [], candidates: [] };
  const lrRep: Report = { lines: [], candidates: [] };
  const geRep: Report = { lines: [], candidates: [] };
  const state: SearchState = { raw: rawTrack, results: { ...preset }, report: { lines: [], candidates: [] } };

  const sync = () => {
    state.report.lines = [...base, ...ytRep.lines, ...lrRep.lines, ...geRep.lines];
    state.report.candidates = geRep.candidates;
  };

  const run = (src: Source, rep: Report, p: Promise<LyricsResult | null>) => {
    p.catch((e: unknown) => {
      console.warn(`[Pear] Lyrics: ${src}`, e);
      rep.lines.push(`${src}: ошибка (${(e as Error).message})`);
      return null;
    }).then((r) => {
      state.results[src] = r;
      sync();
      onUpdate(state);
    });
  };

  sync();
  // источники, уже найденные в кеше, повторно не ищем
  // YouTube ищет по videoId — очищенное название ему не нужно
  if (!preset.YouTube) run('YouTube', ytRep, fetchFromYouTube(videoId, ytRep));
  if (!preset.LRCLib) run('LRCLib', lrRep, fetchFromLRCLib(track, durationP, lrRep));
  if (!preset.Genius) run('Genius', geRep, fetchFromGenius(track, geRep));
  return state;
}

/* ------------------------------------------------------------------ *
 *  Кеш найденных текстов: память + localStorage, LRU
 *  Хранятся только найденные результаты — «не найдено» и ошибки
 *  при следующем запуске ищутся заново.
 * ------------------------------------------------------------------ */
type CachedResults = Partial<Record<Source, LyricsResult>>;

// v2: в v1 тексты Genius могли сохраниться со служебными надписями страницы
const CACHE_KEY = 'pear:lyrics-cache-v2';
const OLD_CACHE_KEYS = ['pear:lyrics-cache'];
const CACHE_LIMIT = 50;

let cache: Map<string, CachedResults> | null = null;

const isLyricsResult = (v: unknown, src: Source): v is LyricsResult => {
  if (!v || typeof v !== 'object') return false;
  const r = v as LyricsResult;
  const syncedOk =
    r.synced === null ||
    (Array.isArray(r.synced) && r.synced.every((l) => l && typeof l.t === 'number' && typeof l.text === 'string'));
  return r.source === src && syncedOk && (r.plain === null || typeof r.plain === 'string') && !!(r.synced || r.plain);
};

function cacheMap(): Map<string, CachedResults> {
  if (cache) return cache;
  cache = new Map();
  try {
    for (const k of OLD_CACHE_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(CACHE_KEY);
    const entries: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[1] || typeof e[1] !== 'object') continue;
        const found: CachedResults = {};
        for (const src of SOURCES) {
          const r = e[1][src];
          if (!isLyricsResult(r, src)) continue;
          // страховка: текст Genius чистим и при чтении, если правила очистки поменяются
          found[src] = src === 'Genius' && r.plain ? { ...r, plain: stripGeniusJunk(r.plain).trim() } : r;
        }
        if (SOURCES.some((src) => found[src])) cache.set(e[0], found);
      }
    }
  } catch {
    /* хранилище недоступно или испорчено — начинаем с пустого кеша */
  }
  return cache;
}

function cacheGet(key: string): CachedResults | undefined {
  const map = cacheMap();
  const hit = map.get(key);
  if (hit) {
    // LRU: недавно использованные — в конец
    map.delete(key);
    map.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, results: Partial<Record<Source, LyricsResult | null>>): void {
  const map = cacheMap();
  const found: CachedResults = { ...map.get(key) };
  let changed = false;
  for (const src of SOURCES) {
    const r = results[src];
    if (r && found[src] !== r) {
      found[src] = r;
      changed = true;
    }
  }
  if (!changed) return;

  map.delete(key);
  map.set(key, found);
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value!);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify([...map]));
      return;
    } catch {
      // скорее всего, переполнено хранилище — выкидываем старую половину и пробуем ещё раз
      const drop = Math.ceil(map.size / 2);
      for (const k of [...map.keys()].slice(0, drop)) map.delete(k);
    }
  }
}

/* ================================================================== *
 *  CSS вкладки «ТЕКСТ»
 * ================================================================== */
const STYLE = `
/* прячем родной текст YouTube Music, показываем свой */
#tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > * { display: none !important; }
#tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] > #pl-container { display: flex !important; height: 100%; }
#tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] { scrollbar-width: none; }
#pl-container { position: relative; flex-direction: column; box-sizing: border-box; width: 100%; color: #fff; font-family: Roboto, Arial, sans-serif; }
/* меню источников — вне #pl-bar, чтобы на него не действовали стили кнопок панели */
#pl-src-menu { position: absolute; top: 40px; right: 4px; z-index: 5; }
#pl-src-menu .pl-src-status { margin-left: auto; padding-left: 16px; font-size: 12px; color: rgba(255,255,255,.6); }
#pl-src-menu button:disabled { cursor: default; opacity: .45; }
#pl-src-menu button:disabled:hover { background: none; }
${QUALITY_MENU_CSS}
#pl-bar { display: flex; align-items: center; gap: 6px; padding: 6px 4px 10px; flex: none; }
#pl-title { flex: 1; min-width: 0; font-size: 12px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#pl-bar button { background: rgba(255,255,255,.1); color: #fff; border: 0; border-radius: 6px; min-width: 28px; height: 26px; padding: 0 6px; font-size: 12px; cursor: pointer; }
#pl-bar button:hover { background: rgba(255,255,255,.22); }
#pl-offset-group { display: flex; align-items: center; gap: 6px; }
#pl-offset { font-size: 11px; opacity: .7; min-width: 44px; text-align: center; }
#pl-body { position: relative; flex: 1; min-height: 0; max-height: calc(100vh - 230px); overflow-y: auto; padding: 30% 8px; scroll-behavior: smooth; scrollbar-width: none; }
#pl-body::-webkit-scrollbar { display: none; }
#pl-body.plain { padding: 8px; scroll-behavior: auto; }
.pl-line { font-weight: 700; line-height: 1.35; margin: 14px 0; opacity: .38; cursor: pointer; transition: opacity .25s, transform .25s; transform-origin: left center; }
.pl-line:hover { opacity: .7; }
.pl-line.current { opacity: 1; transform: scale(1.04); }
.pl-line.past { opacity: .5; }
/* обычный текст (Genius) выглядит как синхронный, только без подсветки текущей строки */
.pl-plain { font-weight: 700; line-height: 1.35; margin: 14px 0; opacity: .9; white-space: pre-wrap; }
.pl-plain.pl-gap { margin-top: 2em; }
.pl-sec { opacity: .45; font-size: .7em; letter-spacing: .04em; margin-bottom: 6px; }
.pl-state { padding: 30px 10px; text-align: center; opacity: .6; font-size: 14px; }
.pl-sub { margin: 16px 0 6px; font-size: 12px; opacity: .6; }
.pl-cand { padding: 8px 10px; margin: 4px 0; border-radius: 8px; background: rgba(255,255,255,.08); cursor: pointer; font-size: .8em; }
.pl-cand:hover { background: rgba(255,255,255,.18); }
.pl-report { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,.3); font: 11px/1.45 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-word; opacity: .8; user-select: text; }
.pl-copy { margin-top: 8px; background: rgba(255,255,255,.12); color: #fff; border: 0; border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.pl-copy:hover { background: rgba(255,255,255,.24); }
`;

/* ================================================================== *
 *  Основная функция
 * ================================================================== */
export function initLyrics(options: LyricsOptions = {}): LyricsController {
  if (!isTopFrame()) return noopController;

  console.log('[Pear] Lyrics initializing...');

  httpGet = options.httpGet ?? tauriHttpGet;
  const config = loadConfig(STORAGE_KEY, DEFAULT_CONFIG, options.config);
  normalize(config);

  let rootReady = false;
  let destroyed = false;
  let active = false;

  const style = createStyle(STYLE);

  let containerEl: HTMLElement | null = null;
  let bodyEl!: HTMLElement;
  let titleEl!: HTMLElement;
  let offsetEl!: HTMLElement;
  let offsetGroupEl!: HTMLElement;

  let srcBtnEl!: HTMLElement;
  let srcMenuEl!: HTMLElement;
  let job: SearchState | null = null;
  let shownResult: LyricsResult | null = null;

  let curLines: LrcLine[] | null = null;
  let lineEls: HTMLElement[] = [];
  let curIdx = -1;

  let tabVisible = false;
  let lyricsToken = 0;
  let lyricsLoadedFor: string | null = null;
  let lastKey = '';
  let observedHeader: Element | null = null;

  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  const tabObserver = new MutationObserver(() => ensureTab());

  /* ---------- длительность нового трека ---------- */
  // Медиасобытия не всплывают, но capture-слушатель на document их ловит
  const DURATION_FRESH_MS = 2000;
  const DURATION_WAIT_MS = 1500;
  let durationAt = 0;
  let durationWaiters: (() => void)[] = [];

  const readDuration = () => {
    const v = getVideo();
    return v && isFinite(v.duration) ? v.duration : 0;
  };

  const onDurationEvent = (e: Event) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !isFinite(v.duration) || v.duration <= 0) return;
    durationAt = performance.now();
    const waiters = durationWaiters;
    durationWaiters = [];
    for (const w of waiters) w();
  };

  // Если длительность только что обновилась — она уже от нового трека, иначе ждём событие
  const waitDuration = () =>
    new Promise<number>((resolve) => {
      if (performance.now() - durationAt < DURATION_FRESH_MS) return resolve(readDuration());
      const done = () => {
        clearTimeout(timer);
        durationWaiters = durationWaiters.filter((w) => w !== done);
        resolve(readDuration());
      };
      const timer = setTimeout(done, DURATION_WAIT_MS);
      durationWaiters.push(done);
    });

  /* ---------- UI ---------- */
  const applyView = () => {
    if (!containerEl) return;
    bodyEl.style.fontSize = `${config.fontSize}px`;
    offsetEl.textContent = `${config.offset >= 0 ? '+' : ''}${(config.offset / 1000).toFixed(1)} c`;
  };

  const buildUI = () => {
    const mk = (label: string, title: string, fn: () => void) => h('button', { title, onclick: fn }, label);
    titleEl = h('div', { id: 'pl-title' }, 'Тексты');
    offsetEl = h('div', { id: 'pl-offset' });
    offsetGroupEl = h(
      'div',
      { id: 'pl-offset-group' },
      mk('−', 'Текст позже на 0.5 с', () => api.setConfig({ offset: config.offset - 500 })),
      offsetEl,
      mk('+', 'Текст раньше на 0.5 с', () => api.setConfig({ offset: config.offset + 500 })),
    );
    const bar = h(
      'div',
      { id: 'pl-bar' },
      titleEl,
      (srcBtnEl = mk(`${config.source} ▾`, 'Источник текста', () => toggleSourceMenu())),
      mk('A−', 'Меньше шрифт', () => api.setConfig({ fontSize: config.fontSize - 2 })),
      mk('A+', 'Больше шрифт', () => api.setConfig({ fontSize: config.fontSize + 2 })),
      offsetGroupEl,
    );
    bodyEl = h('div', { id: 'pl-body' });
    srcMenuEl = h('div', { id: 'pl-src-menu', class: 'pear-qmenu', role: 'menu', 'aria-label': 'Источник текста', hidden: '' });
    containerEl = h('div', { id: 'pl-container' }, bar, srcMenuEl, bodyEl);
    applyView();
  };

  const resetView = () => {
    shownResult = null;
    curLines = null;
    lineEls = [];
    curIdx = -1;
  };

  const showState = (text: string) => {
    resetView();
    offsetGroupEl.style.display = 'none';
    bodyEl.classList.remove('plain');
    bodyEl.replaceChildren(h('div', { class: 'pl-state' }, text));
  };

  const showNotFound = (track: Track, report: Report, headline = 'Текст не найден 😔') => {
    resetView();
    offsetGroupEl.style.display = 'none';
    bodyEl.classList.add('plain');

    const nodes: Node[] = [h('div', { class: 'pl-state' }, headline)];
    if (report.candidates.length) {
      nodes.push(h('div', { class: 'pl-sub' }, 'Возможно, нужная песня есть на Genius — нажмите, чтобы открыть:'));
      for (const c of report.candidates) {
        nodes.push(h('div', { class: 'pl-cand', onclick: () => void loadGeniusPath(c) }, `${c.artist} — ${c.title}`));
      }
    }
    const text = [`Искали: ${track.artist} — ${track.title}`, track.album ? `Альбом: ${track.album}` : '', ...report.lines]
      .filter(Boolean)
      .join('\n');
    nodes.push(
      h('div', { class: 'pl-sub' }, 'Отчёт поиска:'),
      h('pre', { class: 'pl-report' }, text),
      h('button', { class: 'pl-copy', onclick: () => navigator.clipboard?.writeText(text).catch(() => {}) }, 'Скопировать отчёт'),
    );
    bodyEl.replaceChildren(...nodes);
    bodyEl.scrollTop = 0;
  };

  const scrollToCurrent = (instant: boolean) => {
    if (curIdx < 0 || !lineEls[curIdx]) return;
    const el = lineEls[curIdx];
    const top = el.offsetTop - bodyEl.clientHeight / 2 + el.offsetHeight / 2;
    bodyEl.scrollTo({ top, behavior: instant ? 'instant' : 'smooth' });
  };

  const syncLyrics = (forceScroll: boolean) => {
    if (!curLines || !tabVisible || !containerEl?.isConnected) return;
    const v = getVideo();
    if (!v) return;
    const t = v.currentTime * 1000 + config.offset;

    // бинарный поиск последней строки с t_line <= t
    let lo = 0;
    let hi = curLines.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (curLines[mid].t <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }

    if (idx === curIdx && !forceScroll) return;
    curIdx = idx;
    for (let i = 0; i < lineEls.length; i++) {
      lineEls[i].classList.toggle('current', i === idx);
      lineEls[i].classList.toggle('past', i < idx);
    }
    scrollToCurrent(forceScroll);
  };

  const showResult = (result: LyricsResult | null) => {
    if (!result) return showState('Текст не найден 😔');
    resetView();
    shownResult = result;
    titleEl.textContent = `${titleEl.dataset.song || ''} · ${result.source}`.replace(/^ · /, '');

    if (result.synced) {
      curLines = result.synced;
      offsetGroupEl.style.display = 'flex';
      bodyEl.classList.remove('plain');
      lineEls = curLines.map((l) =>
        h(
          'div',
          {
            class: 'pl-line',
            onclick: () => {
              const v = getVideo();
              if (v) v.currentTime = Math.max(0, (l.t - config.offset) / 1000);
            },
          },
          l.text || '♪',
        ),
      );
      bodyEl.replaceChildren(...lineEls);
      bodyEl.scrollTop = 0;
      syncLyrics(true);
    } else {
      offsetGroupEl.style.display = 'none';
      bodyEl.classList.add('plain');
      const frag = document.createDocumentFragment();
      // \u043f\u0443\u0441\u0442\u044b\u0435 \u0441\u0442\u0440\u043e\u043a\u0438 \u043d\u0435 \u0440\u0438\u0441\u0443\u0435\u043c, \u0430 \u043f\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u0435\u043c \u0432 \u043e\u0442\u0441\u0442\u0443\u043f \u043f\u0435\u0440\u0435\u0434 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u043c \u043a\u0443\u043f\u043b\u0435\u0442\u043e\u043c
      let gap = false;
      for (const line of (result.plain || '').split('\n')) {
        if (!line.trim()) {
          gap = frag.childNodes.length > 0;
          continue;
        }
        const cls = ['pl-plain'];
        if (/^\s*\[.*\]\s*$/.test(line)) cls.push('pl-sec');
        if (gap) cls.push('pl-gap');
        gap = false;
        frag.append(h('div', { class: cls.join(' ') }, line.trim()));
      }
      bodyEl.replaceChildren(frag);
      bodyEl.scrollTop = 0;
    }
  };

  /* ---------- загрузка текста ---------- */
  async function loadGeniusPath(c: Candidate) {
    const token = ++lyricsToken;
    showState('Загружаю с Genius…');
    try {
      const r = await fetchGeniusPage(c.path);
      if (token !== lyricsToken || destroyed) return;
      if (r) {
        if (job) {
          job.results.Genius = r;
          cachePut(trackKey(job.raw), job.results);
        }
        showResult(r);
        updateSrcBtn(r.source);
      } else showState('На этой странице Genius текста нет');
    } catch (e) {
      if (token !== lyricsToken || destroyed) return;
      showState(`Ошибка: ${(e as Error).message}`);
    }
  }

  /** Выбранный источник первым, остальные — запасные по порядку */
  const sourceOrder = (): Source[] => [config.source, ...SOURCES.filter((s) => s !== config.source)];

  const updateSrcBtn = (shown: Source | null) => {
    if (!srcBtnEl) return;
    srcBtnEl.textContent = `${shown ?? config.source} ▾`;
    srcBtnEl.title =
      shown && shown !== config.source
        ? `Показан ${shown}: на ${config.source} текста нет. Выбрать источник`
        : 'Выбрать источник текста';
    if (!srcMenuEl.hidden) renderSourceMenu(); // статусы в открытом меню обновляются по ходу поиска
  };

  /* ---------- меню источников ---------- */
  const sourceStatus = (s: Source) => {
    const r = job?.results[s];
    if (r === undefined) return job ? 'ищу…' : '';
    if (r === null) return 'нет текста';
    return r.synced ? 'синхронный' : 'найден';
  };

  const renderSourceMenu = () => {
    const item = (s: Source) =>
      h(
        'button',
        {
          role: 'menuitemradio',
          'aria-checked': String(config.source === s),
          // там, где точно нет текста, выбирать нечего
          ...(job?.results[s] === null ? { disabled: '' } : {}),
          onclick: (e: Event) => {
            e.stopPropagation();
            closeSourceMenu();
            api.setConfig({ source: s });
          },
        },
        svgCheck(),
        s,
        h('span', { class: 'pl-src-status' }, sourceStatus(s)),
      );
    srcMenuEl.replaceChildren(h('div', { class: 'pear-qmenu-title' }, 'Источник текста'), ...SOURCES.map(item));
  };

  const onOutsidePointer = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!srcMenuEl.contains(t) && !srcBtnEl.contains(t)) closeSourceMenu();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSourceMenu();
    }
  };

  function closeSourceMenu() {
    if (srcMenuEl.hidden) return;
    srcMenuEl.hidden = true;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }

  function toggleSourceMenu() {
    if (!srcMenuEl.hidden) return closeSourceMenu();
    renderSourceMenu();
    srcMenuEl.hidden = false;
    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  // Что показывать: выбранный источник; если в нём нет текста — следующий по порядку.
  // Пока более приоритетный источник ещё ищет, его ждём, а не показываем запасной.
  const render = () => {
    if (!job || !containerEl) return;
    const { results, raw, report } = job;
    const order = sourceOrder();

    let pick: Source | null = null;
    let waiting: Source | null = null;
    for (const s of order) {
      if (results[s]) {
        pick = s;
        break;
      }
      if (results[s] === undefined) {
        waiting = s;
        break;
      }
    }

    updateSrcBtn(pick);

    if (pick) {
      const r = results[pick]!;
      if (r !== shownResult) showResult(r); // не перерисовываем, если уже показан этот текст
      return;
    }
    if (waiting === config.source) return showState(`Ищу на ${waiting}…`);
    if (waiting) return showState(`Не найдено на ${config.source} — ищу на ${waiting}…`);
    showNotFound(raw, report);
  };

  const loadLyricsFor = (track: Track) => {
    const token = ++lyricsToken;
    const key = trackKey(track);
    lyricsLoadedFor = key;
    titleEl.dataset.song = `${track.artist} — ${track.title}`;
    titleEl.textContent = titleEl.dataset.song;
    showState('Загрузка…');

    const cached = cacheGet(key);
    // длительность нужна только LRCLib, и то если его нет в кеше
    const durationP = cached?.LRCLib ? Promise.resolve(0) : waitDuration();
    // YouTube ищет текст по videoId текущего ролика
    const videoId =
      document.querySelector<HTMLElement & { getVideoData?: () => { video_id?: string } }>('#movie_player')
        ?.getVideoData?.()?.video_id ?? null;
    job = searchLyrics(
      track,
      videoId,
      durationP,
      (state) => {
        // кешируем даже устаревший результат: предзагрузка прошлого трека тоже пригодится
        cachePut(key, state.results);
        if (token === lyricsToken && !destroyed) render();
      },
      cached,
    );
    render();
  };

  /* ---------- интеграция с вкладкой YouTube Music ---------- */
  const onTabShown = () => {
    const t = readTrack();
    if (t && lyricsLoadedFor !== trackKey(t)) loadLyricsFor(t);
    else syncLyrics(true); // текст предзагружен — подсветить и прокрутить к текущей строке
  };

  function ensureTab() {
    if (!active || !containerEl) return;
    const header = document.querySelector(HEAD_SELECTOR);
    if (!header) {
      tabVisible = false;
      return;
    }

    // YTM отключает вкладку, если у трека нет своего текста — включаем всегда
    if (header.hasAttribute('disabled')) header.removeAttribute('disabled');

    if (observedHeader !== header) {
      tabObserver.disconnect();
      tabObserver.observe(header, { attributes: true, attributeFilter: ['disabled', 'aria-selected'] });
      observedHeader = header;
    }

    const selected = header.getAttribute('aria-selected') === 'true';
    if (selected) {
      const renderer = document.querySelector(TAB_RENDERER_SELECTOR);
      if (renderer && containerEl.parentNode !== renderer) renderer.append(containerEl);
    }

    if (selected && !tabVisible) {
      tabVisible = true;
      onTabShown();
    } else if (!selected) {
      tabVisible = false;
    }
  }

  const openTab = () => {
    const layout = document.querySelector('ytmusic-app-layout');
    const playerOpen = !!layout && (layout.hasAttribute('player-page-open_') || layout.hasAttribute('player-page-open'));
    if (!playerOpen) {
      (document.querySelector('ytmusic-player-bar .toggle-player-page-button') as HTMLElement | null)?.click();
    }
    setTimeout(
      () => {
        const header = document.querySelector(HEAD_SELECTOR) as HTMLElement | null;
        if (header) {
          header.removeAttribute('disabled');
          header.click();
        }
      },
      playerOpen ? 0 : 500,
    );
  };

  /* ---------- отслеживание смены трека ---------- */
  const check = () => {
    if (!active) return;
    ensureTab();

    const t = readTrack();
    if (!t) return;
    const key = trackKey(t);
    if (key === lastKey) return;
    lastKey = key;

    // ищем сразу, даже если вкладка закрыта, — к её открытию текст уже будет готов
    loadLyricsFor(t);
  };

  const onVideoDataChange = () => check();

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyL') return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    e.preventDefault();
    openTab();
  };

  /* ---------- включение / выключение ---------- */
  const enable = () => {
    if (active || !rootReady || destroyed) return;
    active = true;
    style.inject();
    buildUI();

    document.addEventListener('videodatachange', onVideoDataChange);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('durationchange', onDurationEvent, true);
    document.addEventListener('loadedmetadata', onDurationEvent, true);
    tickTimer = setInterval(check, 500);
    syncTimer = setInterval(() => syncLyrics(false), 100);
    check();
  };

  const disable = () => {
    if (!active) return;
    active = false;
    lyricsToken++;

    if (tickTimer) clearInterval(tickTimer);
    if (syncTimer) clearInterval(syncTimer);
    tickTimer = syncTimer = undefined;
    document.removeEventListener('videodatachange', onVideoDataChange);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('durationchange', onDurationEvent, true);
    document.removeEventListener('loadedmetadata', onDurationEvent, true);
    // ожидающие длительность поиски отпускаем сразу, их результаты всё равно отбросит токен
    for (const w of durationWaiters) w();
    durationWaiters = [];
    tabObserver.disconnect();
    observedHeader = null;

    if (containerEl) closeSourceMenu();
    containerEl?.remove();
    containerEl = null;
    style.remove(); // родной текст YouTube Music снова виден

    resetView();
    job = null;
    tabVisible = false;
    lyricsLoadedFor = null;
    lastKey = '';
  };

  /* ---------- запуск, когда появится <html> ---------- */
  const cancelWait = whenRootReady(() => {
    if (destroyed) return;
    rootReady = true;
    if (config.enabled) enable();
    console.log('[Pear] Lyrics active.');
  });

  const api: LyricsController = {
    getConfig: () => ({ ...config }),

    setConfig(patch) {
      const wasEnabled = config.enabled;
      const prevSource = config.source;
      Object.assign(config, patch);
      normalize(config);
      saveConfig(STORAGE_KEY, config);

      if (!rootReady || destroyed) return; // применится при старте

      if (config.enabled && !wasEnabled) enable();
      else if (!config.enabled && wasEnabled) disable();
      else if (config.enabled) {
        applyView();
        if (config.source !== prevSource) {
          shownResult = null; // источник сменился — перерисовать
          render();
        }
      }
    },

    openTab,

    destroy() {
      destroyed = true;
      cancelWait();
      disable();
    },
  };

  return api;
}