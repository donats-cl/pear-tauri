/**
 * История прослушиваний: учёт того, что реально слушали, в базу SQLite на
 * стороне Rust (src-tauri/src/history.rs). Страница истории — history-page.ts.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initHistory } from './features/history';
 *   initHistory();
 *
 * Что считается прослушиванием (как у Last.fm): трек дольше 30 с, прослушана
 * половина или 4 минуты. Время считается только во время воспроизведения —
 * паузы, перемотка вперёд, реклама и лента сэмплов не засчитываются.
 *
 * Клип и песня — один трек: в базу уходит общий ключ «исполнитель|название»
 * (без «Official Video», «feat.» и т. п.) и, если YouTube Music его показал,
 * videoId парной версии.
 */

import { invoke, isTopFrame, readTrack, whenRootReady } from '../core';

/* ------------------------------------------------------------------ *
 *  Ключ трека: одинаковый у клипа и песни
 * ------------------------------------------------------------------ */
const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Служебные слова клипов; скобки с ними выкидываются целиком. Ремиксы, live и т. п. — разные треки */
const JUNK_WORDS = new Set([
  'official', 'video', 'audio', 'lyric', 'lyrics', 'visualizer', 'visualiser', 'mv', 'hd', 'hq', '4k',
  'clip', 'клип', 'премьера', 'premiere', 'explicit', 'официальный', 'видео',
]);
const isJunk = (s: string) => norm(s).split(' ').some((w) => JUNK_WORDS.has(w));
// \b в JS не знает кириллицу — границы слов через Unicode-классы
const FEAT = /\s*[(\[]?\s*(?<![\p{L}\p{N}])(?:feat|ft|featuring)(?![\p{L}\p{N}])\.?\s[^)\]]*[)\]]?/giu;
const ARTIST_JUNK = /\s*(?:-\s*topic|vevo|official)\s*$/i;

/** Основной исполнитель: «A & B», «A, B», «A feat. B» → «A» */
const mainArtist = (artist: string) =>
  (artist || '')
    .split(/\s*(?:,|&|(?<![\p{L}\p{N}])(?:x|feat\.?|ft\.?|featuring)(?![\p{L}\p{N}]))\s*/iu)[0]
    .replace(ARTIST_JUNK, '')
    .trim();

/** Исполнитель без пробелов: «TheWeekndVEVO» и «The Weeknd» совпадут */
const artistKey = (artist: string) => norm(mainArtist(artist)).replace(/ /g, '');

export function trackKey(title: string, artist: string): string {
  const a = artistKey(artist);
  let t = (title || '')
    .replace(/\s*[(\[{]([^)\]}]*)[)\]}]/g, (m, inner: string) => (isJunk(inner) ? '' : m))
    .replace(FEAT, '');
  // хвост «- Official Video» / «| Клип»
  const tail = t.split(/\s+[|\-–—]\s+/);
  if (tail.length >= 2 && isJunk(tail[tail.length - 1])) t = tail.slice(0, -1).join(' - ');
  // у клипов бывает «Исполнитель - Название»
  const parts = t.split(/\s+[-–—]\s+/);
  if (parts.length >= 2 && artistKey(parts[0]) === a) t = parts.slice(1).join(' ');
  return `${a}|${norm(t) || norm(title)}`;
}

/* ------------------------------------------------------------------ *
 *  Связь с Rust
 * ------------------------------------------------------------------ */
interface PlayStart {
  key: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  search: string;
  videoId: string;
  counterpartId: string | null;
  isVideo: boolean;
  durationMs: number;
  startedAt: number;
  playedMs: number;
}

interface PlayerApi extends HTMLElement {
  getVideoData(): { video_id?: string };
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration?(): number;
}

const POLL_MS = 1000;
const PROGRESS_EVERY_MS = 15_000;
const MIN_TRACK_MS = 30_000;
const MAX_THRESHOLD_MS = 4 * 60_000;

/** Тип ролика и парная версия — из данных очереди YouTube Music (если есть) */
function queueInfo(videoId: string): { type?: string; counterpart: string | null } | null {
  for (const el of document.querySelectorAll('ytmusic-player-queue-item')) {
    const d = (el as unknown as { data?: any }).data;
    if (d?.videoId !== videoId) continue;
    const type = d.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
    // песня и клип в очереди — одна обёртка: primary (что играет) + counterpart (парная)
    const w = (el.closest('ytmusic-playlist-panel-video-wrapper-renderer') as unknown as { data?: any } | null)?.data;
    const ids: (string | undefined)[] = [
      w?.primaryRenderer?.playlistPanelVideoRenderer?.videoId,
      ...(w?.counterpart ?? []).map((c: any) => c?.counterpartRenderer?.playlistPanelVideoRenderer?.videoId),
    ];
    return { type, counterpart: ids.find((id) => id && id !== videoId) ?? null };
  }
  return null;
}

interface Session {
  videoId: string;
  startedAt: number;
  playedMs: number;
  lastPos: number;
  playId: number | null;
  starting: boolean;
  lastProgress: number;
}

export function initHistory(): { destroy(): void } {
  if (!isTopFrame()) return { destroy: () => {} };

  let session: Session | null = null;
  let lastTick = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;

  const newSession = (videoId: string, pos: number): Session => ({
    videoId,
    startedAt: Date.now(),
    playedMs: 0,
    lastPos: pos,
    playId: null,
    starting: false,
    lastProgress: 0,
  });

  const report = (s: Session) => {
    if (s.playId === null) return;
    s.lastProgress = Date.now();
    invoke('history_progress', { playId: s.playId, playedMs: Math.round(s.playedMs) }).catch((e: unknown) =>
      console.warn('[Pear] History:', e),
    );
  };

  const finish = (s: Session | null) => {
    if (s) report(s);
  };

  // трек засчитан — записываем; метаданные берём сейчас: к этому моменту
  // YouTube Music точно обновил их под новый трек
  const start = (s: Session, player: PlayerApi) => {
    const track = readTrack();
    if (!track?.title) return;
    const info = queueInfo(s.videoId);
    const isVideo = info?.type
      ? info.type !== 'MUSIC_VIDEO_TYPE_ATV'
      : !!document.querySelector('ytmusic-player')?.hasAttribute('video-mode');
    const duration = player.getDuration?.() ?? 0;
    const play: PlayStart = {
      key: trackKey(track.title, track.artist),
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverUrl: track.art,
      search: norm(`${track.title} ${track.artist} ${track.album}`),
      videoId: s.videoId,
      counterpartId: info?.counterpart ?? null,
      isVideo,
      durationMs: Math.round(duration * 1000),
      startedAt: s.startedAt,
      playedMs: Math.round(s.playedMs),
    };
    s.starting = true;
    invoke<number>('history_start', { play })
      .then((id) => {
        s.playId = id;
        s.lastProgress = Date.now();
        // пока ждали ответ, трек мог доиграть — сохраняем итог
        if (session !== s) report(s);
      })
      .catch((e: unknown) => console.warn('[Pear] History:', e))
      .finally(() => {
        s.starting = false;
      });
  };

  const tick = () => {
    const now = Date.now();
    const delta = Math.min(now - lastTick, 2 * POLL_MS); // сон/свёрнутое окно не считаем
    lastTick = now;

    const player = document.querySelector<PlayerApi>('#movie_player');
    if (!player) return;
    // реклама и лента сэмплов (она тоже играет через основной плеер) — не в счёт
    if (player.classList.contains('ad-showing') || document.getElementById('pear-samples')) return;
    const videoId = player.getVideoData()?.video_id;
    if (!videoId) return;

    const pos = player.getCurrentTime();
    if (!session || session.videoId !== videoId) {
      finish(session);
      session = newSession(videoId, pos);
      return;
    }
    // тот же трек начался заново (повтор) — новое прослушивание
    if (session.playId !== null && pos < 5 && session.lastPos - pos > 10) {
      finish(session);
      session = newSession(videoId, pos);
      return;
    }
    session.lastPos = pos;

    if (player.getPlayerState() !== 1) return; // не играет
    session.playedMs += delta;

    const durationMs = (player.getDuration?.() ?? 0) * 1000;
    if (session.playId === null && !session.starting) {
      if (durationMs > 0 && durationMs < MIN_TRACK_MS) return;
      const threshold = Math.min(MAX_THRESHOLD_MS, Math.max(MIN_TRACK_MS, durationMs / 2));
      if (session.playedMs >= threshold) start(session, player);
    } else if (session.playId !== null && now - session.lastProgress >= PROGRESS_EVERY_MS) {
      report(session);
    }
  };

  const onHide = () => finish(session);

  const cancelWait = whenRootReady(() => {
    timer = setInterval(tick, POLL_MS);
    window.addEventListener('pagehide', onHide);
  });

  return {
    destroy() {
      cancelWait();
      if (timer) clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      finish(session);
      session = null;
    },
  };
}
