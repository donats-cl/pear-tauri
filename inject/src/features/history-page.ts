/**
 * Страница «История» — пункт в боковом меню YouTube Music.
 * Лента прослушиваний по дням и топ треков (клип и песня — один трек),
 * поиск, бесконечная прокрутка. Данные — из SQLite на стороне Rust.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initHistoryPage } from './features/history-page';
 *   initHistoryPage();
 */

import {
  GUIDE_ENTRY_CSS,
  createStyle,
  ensureGuideEntry,
  h,
  invoke,
  isTopFrame,
  removeGuideEntry,
  svgIcon,
  whenRootReady,
} from '../core';

interface TrackRow {
  id: number;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  songVideoId: string | null;
  clipVideoId: string | null;
}
interface PlayRow {
  id: number;
  startedAt: number;
  playedMs: number;
  isVideo: boolean;
  track: TrackRow;
}
interface TopRow {
  plays: number;
  totalMs: number;
  lastPlayed: number;
  track: TrackRow;
}
interface Stats {
  plays: number;
  tracks: number;
  totalMs: number;
  firstPlayed: number | null;
}

type Tab = 'feed' | 'top';

const ROOT_ID = 'pear-history';
const ENTRY_ID = 'history';
const PAGE = 100;
const POLL_MS = 1000;
const SEARCH_DEBOUNCE_MS = 250;
const DAY_MS = 86_400_000;

const ICON = {
  // часы со стрелкой назад — иконка истории YouTube
  history:
    'M14.97 16.95 10 13.87V7h2v5.76l4.03 2.49-1.06 1.7zM12 2C8.73 2 5.8 3.44 4 5.7V3H2v6h6V7H5.08C6.65 5.04 9.15 4 12 4c4.41 0 8 3.59 8 8s-3.59 8-8 8-8-3.59-8-8H2c0 5.51 4.49 10 10 10s10-4.49 10-10S17.51 2 12 2z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  search:
    'M10.5 3a7.5 7.5 0 015.963 12.049l4.244 4.244a1 1 0 01-1.414 1.414l-4.244-4.244A7.5 7.5 0 1110.5 3Zm0 2a5.5 5.5 0 100 11 5.5 5.5 0 000-11Z',
};

const TEXT_FONT = 'Roboto, "Noto Naskh Arabic UI", Arial, sans-serif';
const TITLE_FONT = `"YouTube Sans", ${TEXT_FONT}`;

/* ------------------------------------------------------------------ *
 *  CSS — как страницы YouTube Music: чипы, строки списка, заголовки
 * ------------------------------------------------------------------ */
const STYLE = `
${GUIDE_ENTRY_CSS}
#${ROOT_ID} { position: fixed; inset: 0; z-index: 2200; overflow-y: auto; background: var(--ytmusic-background, #030303); color: #fff; font: 400 14px ${TEXT_FONT}; }
#${ROOT_ID} svg { width: 24px; height: 24px; fill: currentColor; flex: none; }
#${ROOT_ID} button { border: 0; margin: 0; padding: 0; background: none; color: inherit; font: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
#${ROOT_ID} .ph-header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 16px; height: 64px; padding: 0 16px 0 24px; background: var(--ytmusic-background, #030303); }
#${ROOT_ID} .ph-heading { flex: 1; font: 700 24px ${TITLE_FONT}; }
#${ROOT_ID} .ph-icon-btn { width: 40px; height: 40px; border-radius: 50%; }
#${ROOT_ID} .ph-icon-btn:hover { background: rgba(255,255,255,.1); }
#${ROOT_ID} .ph-search { display: flex; align-items: center; gap: 8px; width: min(480px, 40vw); height: 40px; padding: 0 12px; border-radius: 8px; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.1); }
#${ROOT_ID} .ph-search:focus-within { background: #212121; border-color: rgba(255,255,255,.3); }
#${ROOT_ID} .ph-search svg { width: 20px; height: 20px; color: rgba(255,255,255,.7); }
#${ROOT_ID} .ph-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: #fff; font: 400 16px ${TEXT_FONT}; }
#${ROOT_ID} .ph-search input::placeholder { color: rgba(255,255,255,.5); }
#${ROOT_ID} .ph-content { max-width: 1000px; margin: 0 auto; padding: 8px 24px 48px; }
#${ROOT_ID} .ph-stats { color: rgba(255,255,255,.7); margin-bottom: 16px; }
#${ROOT_ID} .ph-chips { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
#${ROOT_ID} .ph-chip { height: 32px; padding: 0 12px; border-radius: 8px; background: rgba(255,255,255,.1); font-weight: 500; }
#${ROOT_ID} .ph-chip:hover { background: rgba(255,255,255,.2); }
#${ROOT_ID} .ph-chip[aria-pressed='true'] { background: #fff; color: #030303; }
#${ROOT_ID} .ph-sep { width: 1px; background: rgba(255,255,255,.2); margin: 4px 4px; }
#${ROOT_ID} .ph-day { font: 700 20px ${TITLE_FONT}; margin: 24px 0 8px; }
#${ROOT_ID} .ph-row { position: relative; display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 8px; border-radius: 4px; cursor: pointer; }
#${ROOT_ID} .ph-row + .ph-row::before { content: ''; position: absolute; left: 8px; right: 8px; top: 0; border-top: 1px solid rgba(255,255,255,.1); }
#${ROOT_ID} .ph-row:hover { background: rgba(255,255,255,.1); }
#${ROOT_ID} .ph-rank { width: 24px; text-align: center; font-weight: 700; color: rgba(255,255,255,.7); flex: none; }
#${ROOT_ID} .ph-thumb { width: 40px; height: 40px; border-radius: 2px; object-fit: cover; flex: none; background: rgba(255,255,255,.1); }
#${ROOT_ID} .ph-text { flex: 1; min-width: 0; }
#${ROOT_ID} .ph-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .ph-sub { color: rgba(255,255,255,.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .ph-badge { display: inline-block; margin-left: 8px; padding: 0 4px; border-radius: 2px; background: rgba(255,255,255,.15); font-size: 11px; line-height: 16px; vertical-align: 1px; color: rgba(255,255,255,.85); }
#${ROOT_ID} .ph-meta { color: rgba(255,255,255,.7); white-space: nowrap; flex: none; }
#${ROOT_ID} .ph-del { width: 40px; height: 40px; border-radius: 50%; visibility: hidden; color: rgba(255,255,255,.7); }
#${ROOT_ID} .ph-row:hover .ph-del { visibility: visible; }
#${ROOT_ID} .ph-del:hover { background: rgba(255,255,255,.1); color: #fff; }
#${ROOT_ID} .ph-del svg { width: 20px; height: 20px; }
#${ROOT_ID} .ph-empty { padding: 64px 0; text-align: center; color: rgba(255,255,255,.7); }
#${ROOT_ID} .ph-more { display: flex; justify-content: center; padding: 24px 0; }
#${ROOT_ID} .ph-spinner { width: 32px; height: 32px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #fff; animation: pear-history-spin .9s linear infinite; }
@keyframes pear-history-spin { to { transform: rotate(360deg); } }
`;

/* ------------------------------------------------------------------ *
 *  Форматирование
 * ------------------------------------------------------------------ */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n.toLocaleString('ru-RU')} ${word}`;
}

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  return min % 60 ? `${hours} ч ${min % 60} мин` : `${hours} ч`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function dayTitle(t: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(t);
  if (day === today) return 'Сегодня';
  if (day === today - DAY_MS) return 'Вчера';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

const clock = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Поиск в базе идёт по нормализованному тексту — нормализуем и запрос */
const normQuery = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/* ------------------------------------------------------------------ *
 *  Основная функция
 * ------------------------------------------------------------------ */
export function initHistoryPage(): { open(): void; close(): void; destroy(): void } {
  const noop = { open: () => {}, close: () => {}, destroy: () => {} };
  if (!isTopFrame()) return noop;

  const style = createStyle(STYLE);
  let destroyed = false;
  let entryTimer: ReturnType<typeof setInterval> | undefined;

  let rootEl: HTMLElement | null = null;
  let statsEl!: HTMLElement;
  let chipsEl!: HTMLElement;
  let listEl!: HTMLElement;
  let moreEl!: HTMLElement;
  let observer: IntersectionObserver | null = null;

  let tab: Tab = 'feed';
  /** период топа: 0 — всё время, иначе дней */
  let period = 0;
  let query = '';
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  // состояние прокрутки текущего списка
  let token = 0;
  let loading = false;
  let done = false;
  let cursor: number | null = null; // лента: id последней строки
  let offset = 0; // топ: сколько уже показано
  let lastDay = -1;

  /* ---------- действия ---------- */
  // полный трек с миксом — через навигацию YouTube Music; песня в приоритете
  const play = (t: TrackRow) => {
    const videoId = t.songVideoId ?? t.clipVideoId;
    if (!videoId) return;
    api.close();
    document.querySelector('ytmusic-app')?.dispatchEvent(
      new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: { endpoint: { watchEndpoint: { videoId, playlistId: `RDAMVM${videoId}` } } },
      }),
    );
  };

  const remove = (row: PlayRow, el: HTMLElement) => {
    invoke('history_delete', { playId: row.id })
      .then(() => {
        el.remove();
        void loadStats();
      })
      .catch((e: unknown) => console.warn('[Pear] History:', e));
  };

  /* ---------- строки ---------- */
  const thumb = (t: TrackRow) => h('img', { class: 'ph-thumb', src: t.coverUrl || '', alt: '', loading: 'lazy' });

  const playRow = (r: PlayRow) => {
    const el = h(
      'div',
      { class: 'ph-row', role: 'button', tabindex: '0', title: 'Слушать с миксом' },
      thumb(r.track),
      h(
        'div',
        { class: 'ph-text' },
        h('div', { class: 'ph-title' }, r.track.title, ...(r.isVideo ? [h('span', { class: 'ph-badge' }, 'Клип')] : [])),
        h('div', { class: 'ph-sub' }, [r.track.artist, r.track.album].filter(Boolean).join(' • ')),
      ),
      h('div', { class: 'ph-meta' }, clock(r.startedAt)),
    );
    const del = h('button', { class: 'ph-del', title: 'Удалить из истории', 'aria-label': 'Удалить из истории' }, svgIcon(ICON.close));
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      remove(r, el);
    });
    el.append(del);
    el.addEventListener('click', () => play(r.track));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') play(r.track);
    });
    return el;
  };

  const topRow = (r: TopRow, rank: number) => {
    const el = h(
      'div',
      { class: 'ph-row', role: 'button', tabindex: '0', title: 'Слушать с миксом' },
      h('div', { class: 'ph-rank' }, rank),
      thumb(r.track),
      h(
        'div',
        { class: 'ph-text' },
        h('div', { class: 'ph-title' }, r.track.title),
        h('div', { class: 'ph-sub' }, [r.track.artist, r.track.album].filter(Boolean).join(' • ')),
      ),
      h('div', { class: 'ph-meta' }, `${plural(r.plays, 'раз', 'раза', 'раз')} · ${duration(r.totalMs)}`),
    );
    el.addEventListener('click', () => play(r.track));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') play(r.track);
    });
    return el;
  };

  /* ---------- загрузка ---------- */
  const loadStats = async () => {
    try {
      const s = await invoke<Stats>('history_stats');
      statsEl.textContent = s.plays
        ? `${plural(s.plays, 'прослушивание', 'прослушивания', 'прослушиваний')} · ${plural(s.tracks, 'трек', 'трека', 'треков')} · ${duration(s.totalMs)}` +
          (s.firstPlayed ? ` · с ${new Date(s.firstPlayed).toLocaleDateString('ru-RU')}` : '')
        : '';
    } catch (e) {
      statsEl.textContent = `Не удалось открыть историю: ${(e as Error).message}`;
    }
  };

  const loadMore = async () => {
    if (loading || done || !rootEl) return;
    loading = true;
    const my = token;
    moreEl.replaceChildren(h('div', { class: 'ph-spinner' }));
    try {
      const search = query || null;
      if (tab === 'feed') {
        const rows = await invoke<PlayRow[]>('history_list', { before: cursor, limit: PAGE, search });
        if (my !== token) return;
        for (const r of rows) {
          const day = startOfDay(r.startedAt);
          if (day !== lastDay) {
            lastDay = day;
            listEl.append(h('div', { class: 'ph-day' }, dayTitle(r.startedAt)));
          }
          listEl.append(playRow(r));
        }
        cursor = rows.length ? rows[rows.length - 1].id : cursor;
        done = rows.length < PAGE;
      } else {
        const since = period ? Date.now() - period * DAY_MS : null;
        const rows = await invoke<TopRow[]>('history_top', { since, limit: PAGE, offset, search });
        if (my !== token) return;
        rows.forEach((r, i) => listEl.append(topRow(r, offset + i + 1)));
        offset += rows.length;
        done = rows.length < PAGE;
      }
      if (done && !listEl.childElementCount) {
        listEl.append(
          h(
            'div',
            { class: 'ph-empty' },
            query ? 'Ничего не нашлось' : 'Здесь появятся треки, которые вы слушаете дольше 30 секунд',
          ),
        );
      }
    } catch (e) {
      if (my === token) listEl.append(h('div', { class: 'ph-empty' }, `Ошибка: ${(e as Error).message}`));
      done = true;
    } finally {
      if (my === token) {
        loading = false;
        moreEl.replaceChildren();
      }
    }
  };

  const reload = () => {
    token++;
    loading = false;
    done = false;
    cursor = null;
    offset = 0;
    lastDay = -1;
    listEl.replaceChildren();
    renderChips();
    void loadMore();
  };

  /* ---------- окно ---------- */
  const chip = (label: string, pressed: boolean, fn: () => void) => {
    const b = h('button', { class: 'ph-chip', 'aria-pressed': String(pressed) }, label);
    b.addEventListener('click', fn);
    return b;
  };

  const renderChips = () => {
    chipsEl.replaceChildren(
      chip('Лента', tab === 'feed', () => {
        tab = 'feed';
        reload();
      }),
      chip('Топ треков', tab === 'top', () => {
        tab = 'top';
        reload();
      }),
      ...(tab === 'top'
        ? [
            h('div', { class: 'ph-sep' }),
            ...([
              [0, 'Всё время'],
              [30, '30 дней'],
              [7, '7 дней'],
            ] as const).map(([days, label]) =>
              chip(label, period === days, () => {
                period = days;
                reload();
              }),
            ),
          ]
        : []),
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !rootEl) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    api.close();
  };

  const buildUI = () => {
    const input = h('input', { type: 'search', placeholder: 'Поиск в истории', 'aria-label': 'Поиск в истории' }) as HTMLInputElement;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = normQuery(input.value);
        reload();
      }, SEARCH_DEBOUNCE_MS);
    });
    const closeBtn = h('button', { class: 'ph-icon-btn', title: 'Закрыть (Esc)', 'aria-label': 'Закрыть' }, svgIcon(ICON.close));
    closeBtn.addEventListener('click', () => api.close());

    statsEl = h('div', { class: 'ph-stats' });
    chipsEl = h('div', { class: 'ph-chips' });
    listEl = h('div', { role: 'list' });
    moreEl = h('div', { class: 'ph-more' });
    rootEl = h(
      'div',
      { id: ROOT_ID, role: 'dialog', 'aria-label': 'История' },
      h(
        'div',
        { class: 'ph-header' },
        h('div', { class: 'ph-heading' }, 'История'),
        h('label', { class: 'ph-search' }, svgIcon(ICON.search), input),
        closeBtn,
      ),
      h('div', { class: 'ph-content' }, statsEl, chipsEl, listEl, moreEl),
    );
    document.body.append(rootEl);

    // бесконечная прокрутка: подгружаем, когда низ списка близко
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    }, { root: rootEl, rootMargin: '800px' });
    observer.observe(moreEl);
    input.focus();
  };

  const api = {
    open() {
      if (rootEl || destroyed || !document.body) return;
      buildUI();
      window.addEventListener('keydown', onKeyDown, true);
      void loadStats();
      reload();
    },

    close() {
      if (!rootEl) return;
      token++;
      clearTimeout(searchTimer);
      observer?.disconnect();
      observer = null;
      window.removeEventListener('keydown', onKeyDown, true);
      rootEl.remove();
      rootEl = null;
    },

    destroy() {
      destroyed = true;
      api.close();
      cancelWait();
      if (entryTimer) clearInterval(entryTimer);
      removeGuideEntry(ENTRY_ID);
      style.remove();
    },
  };

  const ensureEntry = () => ensureGuideEntry(ENTRY_ID, ICON.history, 'История', () => api.open());

  const cancelWait = whenRootReady(() => {
    if (destroyed) return;
    style.inject();
    entryTimer = setInterval(ensureEntry, POLL_MS);
    ensureEntry();
  });

  return api;
}
