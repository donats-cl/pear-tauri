/**
 * Discord Rich Presence — «Слушает …» в профиле Discord
 * (аналог плагина discord из pear-desktop, MIT) для Tauri: без Electron, без Node.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initDiscordRpc } from './features/discord-rpc';
 *   const discord = initDiscordRpc();
 *   // discord.setConfig({ hideWhenPaused: true });
 *   // discord.destroy();
 *
 * Связь с Discord — Rust-команды `discord_set_activity` / `discord_clear_activity`
 * (src-tauri/src/discord_rpc.rs). Rust сам переподключается к Discord и
 * ограничивает частоту обновлений, поэтому здесь достаточно слать изменения.
 */

import { clamp, getVideo, invoke, isTopFrame, loadConfig, readTrack, saveConfig, whenRootReady } from '../core';

export interface DiscordRpcConfig {
  /** Включён ли Rich Presence */
  enabled: boolean;
  /** Скрывать статус сразу при паузе */
  hideWhenPaused: boolean;
  /** Скрывать статус после стольких минут паузы, 0 — никогда */
  pausedTimeout: number;
}

export interface DiscordRpcController {
  getConfig(): DiscordRpcConfig;
  setConfig(patch: Partial<DiscordRpcConfig>): void;
  destroy(): void;
}

/** Полезная нагрузка для Rust-команды `discord_set_activity` */
interface Presence {
  title: string;
  artist: string;
  album: string | null;
  artUrl: string | null;
  videoId: string | null;
  startMs: number | null;
  endMs: number | null;
  paused: boolean;
}

const STORAGE_KEY = 'pear:discord-rpc';
const POLL_MS = 1000;
/** Расхождение позиции, после которого считаем, что была перемотка */
const SEEK_THRESHOLD_MS = 3000;

const DEFAULT_CONFIG: DiscordRpcConfig = {
  enabled: true,
  hideWhenPaused: false,
  pausedTimeout: 10,
};

function normalize(config: DiscordRpcConfig): void {
  config.pausedTimeout = clamp(Math.round(config.pausedTimeout), 0, 24 * 60);
}

const noopController: DiscordRpcController = {
  getConfig: () => ({ ...DEFAULT_CONFIG }),
  setConfig: () => {},
  destroy: () => {},
};

/* ------------------------------------------------------------------ *
 *  Данные трека
 * ------------------------------------------------------------------ */
function readVideoId(): string | null {
  const player = document.querySelector('#movie_player') as { getVideoData?: () => { video_id?: string } } | null;
  const id = player?.getVideoData?.()?.video_id;
  if (id) return id;
  return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
}

// Discord принимает ссылку на картинку не длиннее 256 символов — убираем лишние параметры
function shortenArt(url: string): string | null {
  if (!url.startsWith('https://')) return null;
  if (/\.googleusercontent\.com\//.test(url)) return url.replace(/=[^/=]*$/, '=w512-h512-l90-rj');
  if (/\.ytimg\.com\//.test(url)) return url.split('?')[0];
  return url;
}

/* ------------------------------------------------------------------ *
 *  Основная функция
 * ------------------------------------------------------------------ */
export function initDiscordRpc(options: { config?: Partial<DiscordRpcConfig> } = {}): DiscordRpcController {
  if (!isTopFrame()) return noopController;

  console.log('[Pear] Discord RPC initializing...');

  const config = loadConfig(STORAGE_KEY, DEFAULT_CONFIG, options.config);
  normalize(config);

  let rootReady = false;
  let destroyed = false;
  let active = false;

  let timer: ReturnType<typeof setInterval> | undefined;
  let shown = false;
  let lastKey = '';
  let lastStart = 0;
  let pausedSince = 0;

  const send = (presence: Presence | null) => {
    const p = presence ? invoke('discord_set_activity', { presence }) : invoke('discord_clear_activity');
    p.catch((e: unknown) => console.warn('[Pear] Discord RPC:', e));
  };

  const clear = () => {
    lastKey = '';
    if (!shown) return;
    shown = false;
    send(null);
  };

  /* ---------- отслеживание состояния плеера ---------- */
  const check = () => {
    if (!active) return;
    const track = readTrack();
    const v = getVideo();
    if (!track || !v) return clear();

    const now = Date.now();
    const paused = v.paused;
    if (!paused) pausedSince = 0;
    else if (!pausedSince) pausedSince = now;

    const timedOut = config.pausedTimeout > 0 && paused && now - pausedSince >= config.pausedTimeout * 60_000;
    if (paused && (config.hideWhenPaused || timedOut)) return clear();

    const duration = isFinite(v.duration) ? v.duration * 1000 : 0;
    const start = now - v.currentTime * 1000;
    const key = `${track.title}|${track.artist}|${track.art}|${paused}|${Math.round(duration / 1000)}`;
    // на паузе время стоит, поэтому перемотку отслеживаем только во время воспроизведения
    if (key === lastKey && (paused || Math.abs(start - lastStart) < SEEK_THRESHOLD_MS)) return;
    lastKey = key;
    lastStart = start;
    shown = true;

    send({
      title: track.title,
      artist: track.artist,
      album: track.album || null,
      artUrl: shortenArt(track.art),
      videoId: readVideoId(),
      startMs: paused ? null : Math.round(start),
      endMs: paused || !duration ? null : Math.round(start + duration),
      paused,
    });
  };

  const onVideoDataChange = () => check();

  /* ---------- включение / выключение ---------- */
  const enable = () => {
    if (active || !rootReady || destroyed) return;
    active = true;
    document.addEventListener('videodatachange', onVideoDataChange);
    timer = setInterval(check, POLL_MS);
    check();
  };

  const disable = () => {
    if (!active) return;
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    document.removeEventListener('videodatachange', onVideoDataChange);
    pausedSince = 0;
    clear();
  };

  /* ---------- запуск, когда появится <html> ---------- */
  const cancelWait = whenRootReady(() => {
    if (destroyed) return;
    rootReady = true;
    if (config.enabled) enable();
    console.log('[Pear] Discord RPC active.');
  });

  return {
    getConfig: () => ({ ...config }),

    setConfig(patch) {
      const wasEnabled = config.enabled;
      Object.assign(config, patch);
      normalize(config);
      saveConfig(STORAGE_KEY, config);

      if (!rootReady || destroyed) return; // применится при старте

      if (config.enabled && !wasEnabled) enable();
      else if (!config.enabled && wasEnabled) disable();
      else if (config.enabled) {
        lastKey = ''; // применить новые правила паузы сразу
        check();
      }
    },

    destroy() {
      destroyed = true;
      cancelWait();
      disable();
    },
  };
}
