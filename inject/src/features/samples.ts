/**
 * Samples — бесконечная лента коротких фрагментов треков, как вкладка «Сэмплы»
 * в мобильном YouTube Music. Открывается пунктом «Сэмплы» в боковом меню или Alt+S.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initSamples } from './features/samples';
 *   const samples = initSamples();
 *   // samples.open();
 *   // samples.destroy();
 *
 * Рекомендации — те же, что даёт YouTube Music аккаунту (InnerTube веб-клиента
 * с авторизацией страницы): сначала «Быстрый выбор» с главной, затем бесконечные
 * миксы (радио) от текущего трека, рекомендаций с главной и лайкнутых сэмплов.
 * Лайк/дизлайк уходят в аккаунт YouTube Music; лайк подмешивает похожие треки
 * сразу за текущим, дизлайк пропускает трек и убирает исполнителя из ленты.
 *
 * Воспроизведение: основной плеер YouTube Music (loadVideoById с отрезка
 * фрагмента), кадры видео рисуются в canvas вертикальной карточки.
 * При закрытии ленты восстанавливается трек, который играл до неё.
 */

import {
  GUIDE_ENTRY_CSS,
  createStyle,
  ensureGuideEntry,
  getVideo,
  h,
  isTopFrame,
  loadConfig,
  removeGuideEntry,
  saveConfig,
  svgIcon as icon,
  whenRootReady,
} from '../core';
import { collect, findDeep, innertube, isLoggedIn, runsText } from '../core/innertube';
import {
  QUALITY_ICON,
  QUALITY_MENU_CSS,
  isQuality,
  qualityLabel,
  renderQualityMenu,
  type QualityPlayer,
} from '../core/quality';

export interface SamplesController {
  open(): void;
  close(): void;
  destroy(): void;
}

type Rating = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';

interface Sample {
  videoId: string;
  /** отрезок фрагмента, с; null — посчитаем, когда станет известна длительность */
  start: number | null;
  end: number | null;
  title: string;
  artist: string;
  /** картинка до первого кадра видео */
  frame: string;
  /** обложка трека */
  cover: string;
  rating: Rating;
}

interface PlayerApi extends QualityPlayer {
  loadVideoById(args: { videoId: string; startSeconds?: number }): void;
  cueVideoById(args: { videoId: string; startSeconds?: number }): void;
  getCurrentTime(): number;
  /** -1 не начато, 0 закончилось, 1 играет, 2 пауза, 3 буферизация, 5 подготовлено */
  getPlayerState(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  isMuted?(): boolean;
  mute?(): void;
  unMute?(): void;
}

interface SamplesConfig {
  /** качество клипов: 'auto' или уровень плеера YouTube (hd1080, hd720…) */
  quality: string;
}

const ROOT_ID = 'pear-samples';
const ENTRY_ID = 'samples';
const POLL_MS = 1000;
/** как часто проверять отрезок фрагмента */
const CONTROL_MS = 200;
const WHEEL_COOLDOWN_MS = 700;
const SWIPE_PX = 60;
/** не даём видео доиграть до конца — иначе YouTube Music переключит очередь */
const END_GUARD_S = 0.4;
/** длина фрагмента, с; начало — примерно на трети трека, где обычно уже припев */
const SAMPLE_LEN_S = 30;
const SAMPLE_POS = 0.3;
/** сколько похожих треков подмешивать сразу за лайкнутым */
const LIKE_INJECT = 6;
/** сколько первых рекомендаций с главной станут отправными точками миксов */
const HOME_SEEDS = 5;
/** такие ролики в ленту не берём: подкасты и пользовательские загрузки */
const SKIP_TYPES = new Set(['MUSIC_VIDEO_TYPE_PODCAST_EPISODE', 'MUSIC_VIDEO_TYPE_UGC']);

const STORAGE_KEY = 'pear:samples';
const DEFAULT_CONFIG: SamplesConfig = { quality: 'auto' };
/* ------------------------------------------------------------------ *
 *  Иконки (24×24; лайк, дизлайк, звук, play, закрыть, стрелка — из YouTube Music)
 * ------------------------------------------------------------------ */
const ICON = {
  samples:
    'M7 2h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10' +
    'a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7Zm3 4.5v7l5.5-3.5L10 8.5Z',
  like:
    'M9.221 1.795a1 1 0 011.109-.656l1.04.173a4 4 0 013.252 4.784L14 9h4.061a3.664 3.664 0 013.576 2.868A3.68 3.68 0 0121 14.85l.02.087A3.815 3.815 0 0120 18.5v.043l-.01.227a2.82 2.82 0 01-.135.663l-.106.282A3.754 3.754 0 0116.295 22h-3.606l-.392-.007a12.002 12.002 0 01-5.223-1.388l-.343-.189-.27-.154a2.005 2.005 0 00-.863-.26l-.13-.004H3.5a1.5 1.5 0 01-1.5-1.5V12.5A1.5 1.5 0 013.5 11h1.79l.157-.013a1 1 0 00.724-.512l.063-.145 2.987-8.535Z' +
    'm-1.1 9.196A3 3 0 015.29 13H4v4.998h1.468a4 4 0 011.986.528l.27.155.285.157A10 10 0 0012.69 20h3.606c.754 0 1.424-.483 1.663-1.2l.03-.126a.819.819 0 00.012-.131v-.872l.587-.586c.388-.388.577-.927.523-1.465l-.038-.23-.02-.087-.21-.9.55-.744A1.663 1.663 0 0018.061 11H14a2.002 2.002 0 01-1.956-2.418l.623-2.904a2 2 0 00-1.626-2.392l-.21-.035-2.71 7.741Z',
  dislike:
    'm11.31 2 .392.007c1.824.06 3.61.534 5.223 1.388l.343.189.27.154c.264.152.56.24.863.26l.13.004H20.5a1.5 1.5 0 011.5 1.5V11.5a1.5 1.5 0 01-1.5 1.5h-1.79l-.158.013a1 1 0 00-.723.512l-.064.145-2.987 8.535a1 1 0 01-1.109.656l-1.04-.174a4 4 0 01-3.251-4.783L10 15H5.938a3.664 3.664 0 01-3.576-2.868A3.682 3.682 0 013 9.15l-.02-.088A3.816 3.816 0 014 5.5v-.043l.008-.227a2.86 2.86 0 01.136-.664l.107-.28A3.754 3.754 0 017.705 2h3.605Z' +
    'M7.705 4c-.755 0-1.425.483-1.663 1.2l-.032.126a.818.818 0 00-.01.131v.872l-.587.586a1.816 1.816 0 00-.524 1.465l.038.23.02.087.21.9-.55.744a1.686 1.686 0 00-.321 1.18l.029.177c.17.76.844 1.302 1.623 1.302H10a2.002 2.002 0 011.956 2.419l-.623 2.904-.034.208a2.002 2.002 0 001.454 2.139l.206.045.21.035 2.708-7.741A3.001 3.001 0 0118.71 11H20V6.002h-1.47c-.696 0-1.38-.183-1.985-.528l-.27-.155-.285-.157A10.002 10.002 0 0011.31 4H7.705Z',
  volume:
    'M11.485 2.143 3.913 6.687A6 6 0 001 11.832v.338a6 6 0 002.913 5.144l7.572 4.543A1 1 0 0013 21V3a1.001 1.001 0 00-1.515-.857Zm6.88 2.079a1 1 0 00-.001 1.414 9 9 0 010 12.728 1 1 0 001.414 1.414 11 11 0 000-15.556 1 1 0 00-1.413 0ZM4.941 8.402l.001-.002L11 4.767v14.466l-6.058-3.635A4 4 0 013 12.168v-.337a4 4 0 011.941-3.429ZM15.535 7.05a1 1 0 000 1.415 5 5 0 010 7.07 1 1 0 001.415 1.415 6.999 6.999 0 000-9.9 1 1 0 00-1.415 0Z',
  // динамик YouTube Music + крестик
  muted:
    'M11.485 2.143 3.913 6.687A6 6 0 001 11.832v.338a6 6 0 002.913 5.144l7.572 4.543A1 1 0 0013 21V3a1.001 1.001 0 00-1.515-.857ZM4.941 8.402l.001-.002L11 4.767v14.466l-6.058-3.635A4 4 0 013 12.168v-.337a4 4 0 011.941-3.429Z' +
    'M16.293 9.293a1 1 0 011.414 0L19 10.586l1.293-1.293a1 1 0 111.414 1.414L20.414 12l1.293 1.293a1 1 0 01-1.414 1.414L19 13.414l-1.293 1.293a1 1 0 01-1.414-1.414L17.586 12l-1.293-1.293a1 1 0 010-1.414Z',
  play: 'M5 4.623V19.38a1.5 1.5 0 002.26 1.29L22 12 7.26 3.33A1.5 1.5 0 005 4.623Z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  down: 'M18.707 8.793a1 1 0 00-1.414 0L12 14.086 6.707 8.793a1 1 0 10-1.414 1.414L12 16.914l6.707-6.707a1 1 0 000-1.414Z',
};

/** Активная оценка — залитая иконка: первый контур без внутреннего «выреза» */
const filled = (d: string) => d.slice(0, d.indexOf('Z') + 1);

const setIcon = (btn: Element, d: string) => btn.querySelector('path')?.setAttribute('d', d);

/* ------------------------------------------------------------------ *
 *  CSS — в стилистике YouTube Music: фон и прогресс из темы,
 *  YouTube Sans для заголовков, круглые полупрозрачные кнопки
 * ------------------------------------------------------------------ */
const TEXT_FONT = 'Roboto, "Noto Naskh Arabic UI", Arial, sans-serif';
const TITLE_FONT = `"YouTube Sans", ${TEXT_FONT}`;

const STYLE = `
${GUIDE_ENTRY_CSS}
#${ROOT_ID} { position: fixed; inset: 0; z-index: 2200; display: flex; align-items: center; justify-content: center; background: var(--ytmusic-background, #030303); color: #fff; font: 400 14px ${TEXT_FONT}; overflow: hidden; user-select: none; }
#${ROOT_ID} svg { width: 24px; height: 24px; fill: currentColor; flex: none; }
#${ROOT_ID} .ps-bg { position: absolute; inset: -20%; background: center / cover no-repeat; filter: blur(100px) saturate(1.4); opacity: .35; transition: background-image .4s; pointer-events: none; }
#${ROOT_ID} .ps-header { position: absolute; top: 0; left: 0; right: 0; height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px 0 24px; }
#${ROOT_ID} .ps-heading { font: 700 24px ${TITLE_FONT}; }
#${ROOT_ID} .ps-row { position: relative; display: flex; align-items: flex-end; gap: 16px; }
#${ROOT_ID} .ps-stage { position: relative; height: calc(100vh - 96px); aspect-ratio: 9 / 16; max-width: calc(100vw - 240px); border-radius: 12px; overflow: hidden; background: var(--ytmusic-general-background-a, #181818); cursor: pointer; touch-action: none; }
#${ROOT_ID} .ps-frame, #${ROOT_ID} canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
#${ROOT_ID} .ps-frame[hidden] { display: none; }
#${ROOT_ID} .ps-state { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 16px; align-items: center; justify-content: center; padding: 24px; text-align: center; color: rgba(255,255,255,.7); background: rgba(0,0,0,.5); }
#${ROOT_ID} .ps-state:empty { display: none; }
#${ROOT_ID} .ps-spinner { width: 32px; height: 32px; border-radius: 50%; border: 3px solid rgba(255,255,255,.2); border-top-color: #fff; animation: pear-samples-spin .9s linear infinite; }
@keyframes pear-samples-spin { to { transform: rotate(360deg); } }
#${ROOT_ID} .ps-paused { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; pointer-events: none; }
#${ROOT_ID} .ps-paused svg { width: 32px; height: 32px; margin-left: 4px; }
#${ROOT_ID} .ps-stage.paused .ps-paused { display: flex; }
#${ROOT_ID} .ps-info { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; gap: 12px; padding: 96px 16px 18px; background: linear-gradient(transparent, rgba(0,0,0,.8)); }
#${ROOT_ID} .ps-track { display: flex; align-items: center; gap: 12px; min-width: 0; pointer-events: none; }
#${ROOT_ID} .ps-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; flex: none; background: rgba(255,255,255,.1); }
#${ROOT_ID} .ps-meta { min-width: 0; }
#${ROOT_ID} .ps-title { font: 700 18px/24px ${TITLE_FONT}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .ps-artist { font-size: 14px; line-height: 20px; color: rgba(255,255,255,.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .ps-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255,255,255,.2); pointer-events: none; }
#${ROOT_ID} .ps-progress > div { height: 100%; width: 0; background: var(--paper-progress-active-color-1, #f03); }
#${ROOT_ID} button { border: 0; padding: 0; margin: 0; color: #fff; background: none; font: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
#${ROOT_ID} .ps-pill { align-self: flex-start; gap: 6px; height: 32px; padding: 0 16px 0 12px; border-radius: 16px; background: #fff; color: #030303; font: 500 14px ${TEXT_FONT}; }
#${ROOT_ID} .ps-pill svg { width: 18px; height: 18px; }
#${ROOT_ID} .ps-pill:hover { background: #e5e5e5; }
#${ROOT_ID} .ps-pill.outline { align-self: center; background: none; color: #fff; border: 1px solid rgba(255,255,255,.2); padding: 0 16px; }
#${ROOT_ID} .ps-pill.outline:hover { background: rgba(255,255,255,.1); }
#${ROOT_ID} .ps-actions { display: flex; flex-direction: column; gap: 16px; padding-bottom: 4px; }
#${ROOT_ID} .ps-action { flex-direction: column; gap: 6px; font-size: 12px; line-height: 16px; color: #fff; }
#${ROOT_ID} .ps-action .ps-circle { width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,.1); display: flex; align-items: center; justify-content: center; transition: background .1s; }
#${ROOT_ID} .ps-action:hover .ps-circle { background: rgba(255,255,255,.2); }
#${ROOT_ID} .ps-icon-btn { width: 40px; height: 40px; border-radius: 50%; }
#${ROOT_ID} .ps-icon-btn:hover { background: rgba(255,255,255,.1); }
#${ROOT_ID} .ps-nav { position: absolute; right: 24px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 16px; }
#${ROOT_ID} .ps-nav button { width: 56px; height: 56px; border-radius: 50%; background: rgba(255,255,255,.1); }
#${ROOT_ID} .ps-nav button:hover { background: rgba(255,255,255,.2); }
#${ROOT_ID} .ps-nav button:disabled { opacity: .3; cursor: default; background: rgba(255,255,255,.1); }
#${ROOT_ID} .ps-up svg { transform: rotate(180deg); }
#${ROOT_ID} .ps-toast { position: absolute; left: 24px; bottom: 24px; max-width: 420px; padding: 14px 24px; border-radius: 4px; background: var(--paper-toast-background-color, #323232); box-shadow: 0 2px 6px rgba(0,0,0,.4); font-size: 14px; line-height: 20px; pointer-events: none; opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s; }
#${ROOT_ID} .ps-toast.show { opacity: 1; transform: none; }
#${ROOT_ID} .ps-quality-wrap { position: relative; }
#${ROOT_ID} .ps-menu { position: absolute; right: calc(100% + 12px); bottom: 0; z-index: 1; }
${QUALITY_MENU_CSS}
/* общее правило кнопок ленты (через id) сильнее классов меню */
#${ROOT_ID} .pear-qmenu button { justify-content: flex-start; padding: 0 16px; }
`;

/* ------------------------------------------------------------------ *
 *  Разбор ответов
 * ------------------------------------------------------------------ */
const videoType = (we: any): string | undefined =>
  we?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;

/** "3:45" / "1:02:03" → секунды */
function parseLength(s: string | undefined): number {
  if (!s) return 0;
  return s.split(':').reduce((acc, p) => acc * 60 + (parseInt(p, 10) || 0), 0);
}

function segment(duration: number): [number, number] {
  const len = Math.min(SAMPLE_LEN_S, duration);
  const start = Math.max(0, Math.min(Math.round(duration * SAMPLE_POS), Math.floor(duration - len - 1)));
  return [start, start + len];
}

function makeSample(
  videoId: string,
  title: string,
  artist: string,
  thumbnails: { url?: string }[] | undefined,
  type: string | undefined,
  duration: number,
): Sample | null {
  if (!videoId || (type && SKIP_TYPES.has(type))) return null;
  const cover = thumbnails?.[thumbnails.length - 1]?.url ?? '';
  const [start, end] = duration > 0 ? segment(duration) : [null, null];
  return {
    videoId,
    start,
    end,
    title,
    artist,
    // у клипа — кадр из видео, у трека без видео — обложка
    frame: type === 'MUSIC_VIDEO_TYPE_OMV' ? `https://i.ytimg.com/vi/${videoId}/hq720.jpg` : cover,
    cover,
    rating: 'INDIFFERENT',
  };
}

/** «Быстрый выбор» и другие треки с главной — персональные рекомендации YouTube Music */
function parseHome(data: unknown): Sample[] {
  const out: Sample[] = [];
  const artistOf = (r: unknown) =>
    findDeep(
      r,
      (x) =>
        typeof x.text === 'string' &&
        x.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
          ?.pageType === 'MUSIC_PAGE_TYPE_ARTIST',
    )?.text;

  for (const r of collect(data, 'musicResponsiveListItemRenderer')) {
    const cols = r.flexColumns ?? [];
    const col = (i: number) => cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text;
    const we = findDeep(col(0), (x) => typeof x.watchEndpoint?.videoId === 'string')?.watchEndpoint;
    const videoId = r.playlistItemData?.videoId ?? we?.videoId;
    const s = makeSample(
      videoId,
      runsText(col(0)),
      artistOf(r) ?? col(1)?.runs?.[0]?.text ?? '',
      findDeep(r.thumbnail, (x) => Array.isArray(x.thumbnails))?.thumbnails,
      videoType(we),
      0,
    );
    if (s) out.push(s);
  }

  // карточки: берём только ролики и треки, не альбомы и плейлисты
  for (const r of collect(data, 'musicTwoRowItemRenderer')) {
    const we = r.navigationEndpoint?.watchEndpoint;
    if (!we?.videoId) continue;
    const s = makeSample(
      we.videoId,
      runsText(r.title),
      artistOf(r) ?? r.subtitle?.runs?.[0]?.text ?? '',
      findDeep(r.thumbnailRenderer, (x) => Array.isArray(x.thumbnails))?.thumbnails,
      videoType(we),
      0,
    );
    if (s) out.push(s);
  }
  return out;
}

/** Очередь микса (радио) YouTube Music + токен продолжения */
function parseRadio(data: unknown): { items: Sample[]; next: string | null } {
  const items = collect(data, 'playlistPanelVideoRenderer')
    .map((r) =>
      makeSample(
        r.videoId,
        runsText(r.title),
        r.shortBylineText?.runs?.[0]?.text ?? r.longBylineText?.runs?.[0]?.text ?? '',
        r.thumbnail?.thumbnails,
        videoType(r.navigationEndpoint?.watchEndpoint),
        parseLength(r.lengthText?.runs?.[0]?.text),
      ),
    )
    .filter((s): s is Sample => !!s);
  const next = findDeep(data, (x) => typeof x.nextRadioContinuationData?.continuation === 'string');
  return { items, next: next?.nextRadioContinuationData.continuation ?? null };
}

const fetchRadio = async (videoId: string) =>
  parseRadio(
    await innertube('next', {
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: false,
      tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
    }),
  );

const RATE_ENDPOINT: Record<Rating, string> = {
  LIKE: 'like/like',
  DISLIKE: 'like/dislike',
  INDIFFERENT: 'like/removelike',
};

const normArtist = (s: string) => s.trim().toLowerCase();

const getPlayer = () => document.querySelector<PlayerApi>('#movie_player');

const noopController: SamplesController = { open: () => {}, close: () => {}, destroy: () => {} };

/* ------------------------------------------------------------------ *
 *  Основная функция
 * ------------------------------------------------------------------ */
export function initSamples(): SamplesController {
  if (!isTopFrame()) return noopController;

  console.log('[Pear] Samples initializing...');

  const style = createStyle(STYLE);
  let destroyed = false;
  let entryTimer: ReturnType<typeof setInterval> | undefined;

  // лента
  const list: Sample[] = [];
  const seen = new Set<string>();
  const blockedArtists = new Set<string>();
  /** треки, от которых строятся следующие миксы (лайкнутые — в начале) */
  const seeds: string[] = [];
  let radioToken: string | null = null;
  let homeLoaded = false;
  let loading: Promise<void> | null = null;
  let index = -1;

  // открытая лента
  let rootEl: HTMLElement | null = null;
  let stageEl!: HTMLElement;
  let bgEl!: HTMLElement;
  let frameEl!: HTMLImageElement;
  let canvas!: HTMLCanvasElement;
  let stateEl!: HTMLElement;
  let toastEl!: HTMLElement;
  let coverEl!: HTMLImageElement;
  let titleEl!: HTMLElement;
  let artistEl!: HTMLElement;
  let progressEl!: HTMLElement;
  let prevBtn!: HTMLButtonElement;
  let likeBtn!: HTMLButtonElement;
  let dislikeBtn!: HTMLButtonElement;
  let muteBtn!: HTMLButtonElement;
  let raf = 0;
  let controlTimer: ReturnType<typeof setInterval> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | null = null;
  let lastWheel = 0;
  let pointerY: number | null = null;
  /** что играло до открытия ленты */
  let before: { videoId: string; time: number; paused: boolean } | null = null;

  // качество клипов
  const config = loadConfig(STORAGE_KEY, DEFAULT_CONFIG);
  if (!isQuality(config.quality)) config.quality = 'auto';
  let qualityBtn!: HTMLButtonElement;
  let qualityMenu!: HTMLElement;
  /** для какого сэмпла качество уже выставлено */
  let qualityFor: string | null = null;
  /** качество, которое было в YouTube Music до открытия ленты */
  let qualityBefore = 'auto';

  /* ---------- пункт «Сэмплы» в боковом меню ---------- */
  const ensureEntries = () => ensureGuideEntry(ENTRY_ID, ICON.samples, 'Сэмплы', () => api.open());

  /* ---------- бесконечная лента рекомендаций ---------- */
  const accept = (s: Sample) => !seen.has(s.videoId) && !blockedArtists.has(normArtist(s.artist));

  // Следующая порция: главная → миксы от отправных точек → продолжение последнего микса
  const nextBatch = async (): Promise<Sample[]> => {
    if (!homeLoaded) {
      homeLoaded = true;
      const items = parseHome(await innertube('browse', { browseId: 'FEmusic_home' }));
      seeds.push(...items.slice(0, HOME_SEEDS).map((s) => s.videoId));
      return items;
    }
    const seed = seeds.shift();
    if (seed) {
      const { items, next } = await fetchRadio(seed);
      radioToken = next;
      return items;
    }
    if (radioToken) {
      const { items, next } = parseRadio(await innertube('next', { continuation: radioToken }));
      radioToken = next;
      return items;
    }
    // микс кончился — строим новый от случайного недавнего трека ленты
    const recent = list.slice(-20).filter((s) => s.rating !== 'DISLIKE');
    const pick = recent[Math.floor(Math.random() * recent.length)];
    if (!pick) throw new Error('YouTube Music не вернул рекомендаций');
    seeds.push(pick.videoId);
    return [];
  };

  const loadMore = (): Promise<void> => {
    if (loading) return loading;
    loading = (async () => {
      // пустые порции (всё уже было или отфильтровано) не считаем — пробуем дальше
      for (let attempt = 0; attempt < 5; attempt++) {
        let added = 0;
        for (const s of await nextBatch()) {
          if (!accept(s)) continue;
          seen.add(s.videoId);
          list.push(s);
          added++;
        }
        if (added) return;
      }
    })().finally(() => {
      loading = null;
    });
    return loading;
  };

  /* ---------- отрисовка ---------- */
  /** Загрузка (спиннер) или ошибка с кнопкой «Повторить»; пустая строка — скрыть */
  const setState = (text: string, retry = false) => {
    stateEl.replaceChildren();
    if (!text) return;
    if (!retry) stateEl.append(h('div', { class: 'ps-spinner' }));
    stateEl.append(h('div', {}, text));
    if (retry) {
      stateEl.append(
        h('button', { class: 'ps-pill outline', onclick: (e: Event) => { e.stopPropagation(); go(1); } }, 'Повторить'),
      );
    }
  };

  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  };

  const fitCanvas = () => {
    const r = stageEl.getBoundingClientRect();
    const k = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(r.width * k));
    canvas.height = Math.max(1, Math.round(r.height * k));
  };

  // кадр видео с обрезкой под вертикальную карточку, как object-fit: cover
  const draw = (v: HTMLVideoElement): boolean => {
    const ctx = canvas.getContext('2d');
    if (!ctx || !v.videoWidth) return false; // у трека без видео остаётся обложка
    const scale = Math.max(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const hgt = v.videoHeight * scale;
    ctx.drawImage(v, (canvas.width - w) / 2, (canvas.height - hgt) / 2, w, hgt);
    return true;
  };

  /** Текущий сэмпл, если плеер играет именно его (а не рекламу и не прежний трек) */
  const current = () => {
    const s = list[index];
    const v = getVideo();
    const player = getPlayer();
    if (!s || !v || !player || player.getVideoData()?.video_id !== s.videoId) return null;
    // пока идёт реклама, <video> показывает её, а не трек — ждём
    if (player.classList.contains('ad-showing')) return null;
    const state = player.getPlayerState();
    if ((state !== 0 && state !== 1 && state !== 2) || v.readyState < 2) return null;
    return { s, v, player, state };
  };

  // Управление воспроизведением — на таймере, а не в requestAnimationFrame:
  // rAF не срабатывает в свёрнутом окне, и трек доиграл бы до конца
  const control = () => {
    const c = current();
    if (!c) return;
    const { s, v, player, state } = c;

    // выбранное качество — один раз на сэмпл, когда реклама уже прошла
    if (qualityFor !== s.videoId) {
      qualityFor = s.videoId;
      applyQuality();
    }

    // длительность из ответа была неизвестна — выбираем отрезок по настоящей
    if (s.start === null || s.end === null) {
      if (!isFinite(v.duration) || v.duration <= 0) return;
      [s.start, s.end] = segment(v.duration);
      player.seekTo(s.start, true);
      return;
    }

    // время берём у плеера: оно относится к треку, а не к рекламе
    const t = player.getCurrentTime();
    const end = isFinite(v.duration) ? Math.min(s.end, v.duration - END_GUARD_S) : s.end;
    if (state === 0 || t >= end || t < s.start - 1) {
      player.seekTo(s.start, true); // фрагмент крутится по кругу
      if (state === 0) player.playVideo();
      return;
    }

    stageEl.classList.toggle('paused', state === 2);
    progressEl.style.width = `${Math.max(0, Math.min(1, (t - s.start) / (s.end - s.start))) * 100}%`;
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const c = current();
    if (c && c.s.start !== null && draw(c.v)) frameEl.hidden = true;
  };

  const updateRatingBtns = () => {
    const s = list[index];
    setIcon(likeBtn, s?.rating === 'LIKE' ? filled(ICON.like) : ICON.like);
    setIcon(dislikeBtn, s?.rating === 'DISLIKE' ? filled(ICON.dislike) : ICON.dislike);
    likeBtn.setAttribute('aria-pressed', String(s?.rating === 'LIKE'));
    dislikeBtn.setAttribute('aria-pressed', String(s?.rating === 'DISLIKE'));
  };

  const show = (i: number) => {
    const s = list[i];
    if (!s || !rootEl) return;
    index = i;
    setState('');
    stageEl.classList.remove('paused');
    frameEl.onerror = () => {
      frameEl.onerror = null;
      frameEl.src = s.cover; // у клипа может не быть кадра в HD
    };
    frameEl.src = s.frame || s.cover;
    frameEl.hidden = false;
    bgEl.style.backgroundImage = s.cover ? `url("${s.cover}")` : 'none';
    coverEl.src = s.cover;
    titleEl.textContent = s.title;
    artistEl.textContent = s.artist;
    progressEl.style.width = '0';
    prevBtn.disabled = i === 0;
    updateRatingBtns();
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    getPlayer()?.loadVideoById({ videoId: s.videoId, startSeconds: s.start ?? 0 });
    if (list.length - i <= 3) void loadMore().catch(() => {}); // подгружаем заранее
  };

  const go = (delta: number) => {
    const i = index + delta;
    if (i < 0) return;
    if (i < list.length) return show(i);
    setState('Загрузка…');
    loadMore()
      .then(() => {
        if (!rootEl) return;
        if (i < list.length) show(i);
        else setState('YouTube Music не вернул новых рекомендаций', true);
      })
      .catch((e: unknown) => rootEl && setState(`Не удалось загрузить рекомендации: ${(e as Error).message}`, true));
  };

  const togglePause = () => {
    const player = getPlayer();
    if (!player) return;
    const playing = player.getPlayerState() === 1;
    if (playing) player.pauseVideo();
    else player.playVideo();
    stageEl.classList.toggle('paused', playing);
  };

  /* ---------- качество ---------- */
  const applyQuality = () => {
    getPlayer()?.setPlaybackQualityRange?.(config.quality, config.quality);
  };

  const updateQualityBtn = () => {
    qualityBtn.querySelector('.ps-label')!.textContent = qualityLabel(config.quality);
  };

  const closeQualityMenu = () => {
    qualityMenu.hidden = true;
  };

  const setQuality = (q: string) => {
    config.quality = q;
    saveConfig(STORAGE_KEY, config);
    applyQuality();
    updateQualityBtn();
    closeQualityMenu();
  };

  // список — то, что есть у текущего клипа; пока он не загрузился, стандартный
  const openQualityMenu = () => {
    const player = getPlayer();
    const s = list[index];
    renderQualityMenu(qualityMenu, {
      player,
      loaded: !!s && player?.getVideoData()?.video_id === s.videoId && !player.classList.contains('ad-showing'),
      selected: config.quality,
      onPick: setQuality,
    });
    qualityMenu.hidden = false;
  };

  const toggleQualityMenu = () => (qualityMenu.hidden ? openQualityMenu() : closeQualityMenu());

  const updateMuteBtn = () => {
    const muted = !!getPlayer()?.isMuted?.();
    setIcon(muteBtn, muted ? ICON.muted : ICON.volume);
    muteBtn.querySelector('.ps-label')!.textContent = muted ? 'Без звука' : 'Звук';
  };

  const toggleMute = () => {
    const player = getPlayer();
    if (!player?.isMuted) return;
    if (player.isMuted()) player.unMute?.();
    else player.mute?.();
    updateMuteBtn();
  };

  /* ---------- оценки ---------- */
  const sendRating = (s: Sample, rating: Rating) => {
    if (!isLoggedIn()) {
      toast('Войдите в аккаунт YouTube Music, чтобы оценка сохранилась');
      return;
    }
    innertube(RATE_ENDPOINT[rating], { target: { videoId: s.videoId } }).catch((e: unknown) =>
      toast(`Оценка не сохранилась: ${(e as Error).message}`),
    );
  };

  // похожие треки сразу за лайкнутым — лента подстраивается под вкус
  const injectSimilar = async (s: Sample) => {
    try {
      const { items } = await fetchRadio(s.videoId);
      const fresh = items.filter(accept).slice(0, LIKE_INJECT);
      for (const x of fresh) seen.add(x.videoId);
      const at = list.indexOf(s);
      if (at >= 0) list.splice(at + 1, 0, ...fresh);
    } catch {
      /* не страшно: трек всё равно станет отправной точкой микса */
    }
  };

  const like = () => {
    const s = list[index];
    if (!s) return;
    s.rating = s.rating === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
    updateRatingBtns();
    sendRating(s, s.rating);
    if (s.rating === 'LIKE') {
      seeds.unshift(s.videoId);
      void injectSimilar(s);
    }
  };

  const dislike = () => {
    const s = list[index];
    if (!s) return;
    if (s.rating === 'DISLIKE') {
      s.rating = 'INDIFFERENT';
      blockedArtists.delete(normArtist(s.artist));
      updateRatingBtns();
      sendRating(s, s.rating);
      return;
    }
    s.rating = 'DISLIKE';
    updateRatingBtns();
    sendRating(s, s.rating);

    // исполнителя больше не показываем: убираем его из ещё не показанных треков
    const artist = normArtist(s.artist);
    if (artist) {
      blockedArtists.add(artist);
      for (let i = list.length - 1; i > index; i--) {
        if (normArtist(list[i].artist) === artist) list.splice(i, 1);
      }
    }
    toast(artist ? `Больше не покажем: ${s.artist}` : 'Пропущено');
    go(1);
  };

  // полный трек с миксом — через навигацию YouTube Music, чтобы собралась очередь
  const playFull = () => {
    const s = list[index];
    if (!s) return;
    before = null; // возвращать прежний трек не нужно
    api.close();
    document.querySelector('ytmusic-app')?.dispatchEvent(
      new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: { endpoint: { watchEndpoint: { videoId: s.videoId, playlistId: `RDAMVM${s.videoId}` } } },
      }),
    );
  };

  /* ---------- ввод ---------- */
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const now = Date.now();
    if (Math.abs(e.deltaY) < 20 || now - lastWheel < WHEEL_COOLDOWN_MS) return;
    lastWheel = now;
    go(e.deltaY > 0 ? 1 : -1);
  };

  const onPointerDown = (e: PointerEvent) => {
    pointerY = e.clientY;
  };

  // свайп вверх/вниз — следующий/предыдущий, короткий клик — пауза
  const onPointerUp = (e: PointerEvent) => {
    if (pointerY === null) return;
    const dy = e.clientY - pointerY;
    pointerY = null;
    // кнопки внутри карточки («Слушать», «Повторить») — не пауза
    if ((e.target as Element).closest('button')) return;
    if (Math.abs(dy) >= SWIPE_PX) go(dy < 0 ? 1 : -1);
    else togglePause();
  };

  // перехватываем клавиши раньше YouTube Music, пока лента открыта
  const onKeyDown = (e: KeyboardEvent) => {
    if (!rootEl) return;
    const actions: Record<string, () => void> = {
      // Esc сначала закрывает меню качества, потом ленту
      Escape: () => (qualityMenu.hidden ? api.close() : closeQualityMenu()),
      KeyQ: toggleQualityMenu,
      ArrowDown: () => go(1),
      KeyJ: () => go(1),
      ArrowUp: () => go(-1),
      KeyK: () => go(-1),
      Space: togglePause,
      KeyM: toggleMute,
      KeyL: like,
      KeyD: dislike,
      Enter: playFull,
    };
    const action = actions[e.code];
    if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    action();
  };

  const onHotkey = (e: KeyboardEvent) => {
    if (rootEl || !e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyS') return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    e.preventDefault();
    api.open();
  };

  /* ---------- окно ленты ---------- */
  const buildUI = () => {
    const btn = (cls: string, title: string, fn: () => void, ...children: (Node | string)[]) =>
      h(
        'button',
        { class: cls, title, 'aria-label': title, onclick: (e: Event) => { e.stopPropagation(); fn(); } },
        ...children,
      ) as HTMLButtonElement;
    // кнопка действия как у вертикальной ленты YouTube: круг с иконкой и подпись под ним
    const action = (d: string, label: string, title: string, fn: () => void) =>
      btn('ps-action', title, fn, h('span', { class: 'ps-circle' }, icon(d)), h('span', { class: 'ps-label' }, label));

    bgEl = h('div', { class: 'ps-bg' });
    frameEl = h('img', { class: 'ps-frame', alt: '' }) as HTMLImageElement;
    canvas = h('canvas') as HTMLCanvasElement;
    stateEl = h('div', { class: 'ps-state' });
    toastEl = h('div', { class: 'ps-toast', role: 'status' });
    coverEl = h('img', { class: 'ps-cover', alt: '' }) as HTMLImageElement;
    titleEl = h('div', { class: 'ps-title' });
    artistEl = h('div', { class: 'ps-artist' });
    progressEl = h('div');
    stageEl = h(
      'div',
      { class: 'ps-stage' },
      frameEl,
      canvas,
      h('div', { class: 'ps-paused' }, icon(ICON.play)),
      h(
        'div',
        { class: 'ps-info' },
        h('div', { class: 'ps-track' }, coverEl, h('div', { class: 'ps-meta' }, titleEl, artistEl)),
        btn('ps-pill', 'Слушать трек с миксом (Enter)', playFull, icon(ICON.play), 'Слушать'),
      ),
      h('div', { class: 'ps-progress' }, progressEl),
      stateEl,
    );
    likeBtn = action(ICON.like, 'Нравится', 'Нравится (L)', like);
    dislikeBtn = action(ICON.dislike, 'Не нравится', 'Не нравится — больше не показывать исполнителя (D)', dislike);
    muteBtn = action(ICON.volume, 'Звук', 'Звук (M)', toggleMute);
    qualityBtn = action(QUALITY_ICON, qualityLabel(config.quality), 'Качество видео (Q)', toggleQualityMenu);
    qualityMenu = h('div', { class: 'ps-menu pear-qmenu', role: 'menu', 'aria-label': 'Качество', hidden: '' });
    prevBtn = btn('ps-up', 'Предыдущий (↑)', () => go(-1), icon(ICON.down));
    rootEl = h(
      'div',
      { id: ROOT_ID, role: 'dialog', 'aria-label': 'Сэмплы' },
      bgEl,
      h(
        'div',
        { class: 'ps-header' },
        h('div', { class: 'ps-heading' }, 'Сэмплы'),
        btn('ps-icon-btn', 'Закрыть (Esc)', () => api.close(), icon(ICON.close)),
      ),
      h(
        'div',
        { class: 'ps-row' },
        stageEl,
        h(
          'div',
          { class: 'ps-actions' },
          likeBtn,
          dislikeBtn,
          muteBtn,
          h('div', { class: 'ps-quality-wrap' }, qualityBtn, qualityMenu),
        ),
      ),
      h('div', { class: 'ps-nav' }, prevBtn, btn('ps-down', 'Следующий (↓)', () => go(1), icon(ICON.down))),
      toastEl,
    );

    rootEl.addEventListener('wheel', onWheel, { passive: false });
    // клик мимо меню качества закрывает его
    rootEl.addEventListener('pointerdown', (e) => {
      if (!qualityMenu.hidden && !(e.target as Element).closest('.ps-quality-wrap')) closeQualityMenu();
    });
    stageEl.addEventListener('pointerdown', onPointerDown);
    stageEl.addEventListener('pointerup', onPointerUp);
    resizeObserver = new ResizeObserver(fitCanvas);
    resizeObserver.observe(stageEl);
    document.body.append(rootEl);
    updateMuteBtn();
  };

  const api: SamplesController = {
    open() {
      if (rootEl || destroyed || !document.body) return;
      const player = getPlayer();
      const videoId = player?.getVideoData()?.video_id;
      before = videoId ? { videoId, time: player!.getCurrentTime(), paused: player!.getPlayerState() !== 1 } : null;
      qualityBefore = player?.getUserPlaybackQualityPreference?.() || 'auto';
      qualityFor = null;
      player?.pauseVideo();
      // первый микс — от того, что слушали только что
      if (videoId && !seeds.includes(videoId)) seeds.unshift(videoId);

      buildUI();
      window.addEventListener('keydown', onKeyDown, true);
      raf = requestAnimationFrame(tick);
      controlTimer = setInterval(control, CONTROL_MS);
      if (index >= 0 && index < list.length) show(index);
      else {
        setState('Загрузка рекомендаций…');
        go(1);
      }
    },

    close() {
      if (!rootEl) return;
      cancelAnimationFrame(raf);
      clearInterval(controlTimer);
      clearTimeout(toastTimer);
      window.removeEventListener('keydown', onKeyDown, true);
      resizeObserver?.disconnect();
      resizeObserver = null;
      rootEl.remove();
      rootEl = null;

      // возвращаем то, что играло до ленты
      const player = getPlayer();
      if (!player) return;
      // плеер запоминает качество для всего YouTube Music — возвращаем прежнее
      player.setPlaybackQualityRange?.(qualityBefore, qualityBefore);
      if (before) {
        const args = { videoId: before.videoId, startSeconds: before.time };
        if (before.paused) player.cueVideoById(args);
        else player.loadVideoById(args);
      } else if (index >= 0) {
        player.pauseVideo();
      }
      before = null;
    },

    destroy() {
      destroyed = true;
      api.close();
      cancelWait();
      if (entryTimer) clearInterval(entryTimer);
      document.removeEventListener('keydown', onHotkey);
      removeGuideEntry(ENTRY_ID);
      style.remove();
    },
  };

  /* ---------- запуск, когда появится <html> ---------- */
  const cancelWait = whenRootReady(() => {
    if (destroyed) return;
    style.inject();
    document.addEventListener('keydown', onHotkey);
    entryTimer = setInterval(ensureEntries, POLL_MS);
    ensureEntries();
    console.log('[Pear] Samples active.');
  });

  return api;
}
