/**
 * Album color theme — порт плагина album-color-theme из pear-desktop (MIT)
 * для Tauri: без Electron, без Node, без внешних библиотек.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initAlbumColor } from './features/album-color';
 *   const albumColor = initAlbumColor();
 *   // albumColor.setConfig({ ratio: 0.7 });
 *   // albumColor.destroy();
 */

import { clamp, createStyle, isTopFrame, loadConfig, readTrack, saveConfig, whenRootReady, type Track } from '../core';

export interface AlbumColorConfig {
  /** Включена ли тема */
  enabled: boolean;
  /** Интенсивность смешивания с цветом обложки, 0..1 */
  ratio: number;
  /** Цветной seekbar */
  seekbar: boolean;
}

export interface AlbumColorOptions {
  config?: Partial<AlbumColorConfig>;
  /**
   * Свой загрузчик обложки (например, через Rust-команду, если CORS мешает).
   * По умолчанию используется обычный fetch, затем <img crossOrigin>.
   */
  fetchImage?: (url: string) => Promise<Blob>;
}

export interface AlbumColorController {
  getConfig(): AlbumColorConfig;
  setConfig(patch: Partial<AlbumColorConfig>): void;
  destroy(): void;
}

type RGB = [number, number, number];

const STORAGE_KEY = 'pear:album-color';
const COLOR_KEY = '--ytmusic-album-color';
const DARK_COLOR_KEY = '--ytmusic-album-color-dark';
const RATIO_KEY = '--ytmusic-album-color-ratio';
const SEEKBAR_CLASS = 'seekbar-theme';

const DEFAULT_CONFIG: AlbumColorConfig = {
  enabled: true,
  ratio: 0.5,
  seekbar: true,
};

/* ------------------------------------------------------------------ *
 *  CSS (из style.css оригинала)
 * ------------------------------------------------------------------ */
const STYLE = `
yt-page-navigation-progress {
  --yt-page-navigation-container-color: #00000046 !important;
  --yt-page-navigation-progress-color: white !important;
}
#player-page {
  transition: transform 300ms, background-color 300ms cubic-bezier(0.2, 0, 0.6, 1) !important;
}
#nav-bar-background {
  transition: opacity 200ms, background-color 300ms cubic-bezier(0.2, 0, 0.6, 1) !important;
}
#mini-guide-background {
  transition: opacity 200ms, background-color 300ms cubic-bezier(0.2, 0, 0.6, 1) !important;
  border-right: 0px !important;
}
#guide-wrapper {
  transition: opacity 200ms, background-color 300ms cubic-bezier(0.2, 0, 0.6, 1) !important;
}
#items {
  border-radius: 10px !important;
}
ytmusic-app-layout > [slot='player-page']:not([is-mweb-modernization-enabled]):not(:has(ytmusic-player[player-ui-state='FULLSCREEN'])) {
  padding-top: 90px;
  margin-top: calc(-90px + var(--menu-bar-height, 0px)) !important;
}
.duration.ytmusic-player-queue-item,
.byline.ytmusic-player-queue-item {
  color: rgba(255, 255, 255, 0.5) !important;
  --yt-endpoint-color: rgba(255, 255, 255, 0.5) !important;
  --yt-endpoint-hover-color: rgba(255, 255, 255, 0.5) !important;
  --yt-endpoint-visited-color: rgba(255, 255, 255, 0.5) !important;
}
.icon.ytmusic-menu-navigation-item-renderer {
  color: rgba(255, 255, 255, 0.5) !important;
}
.menu.ytmusic-player-bar {
  --iron-icon-fill-color: rgba(255, 255, 255, 0.5) !important;
}
ytmusic-player-bar {
  color: rgba(255, 255, 255, 0.5) !important;
}
.time-info.ytmusic-player-bar {
  color: rgba(255, 255, 255, 0.5) !important;
}
.volume-slider.ytmusic-player-bar,
.expand-volume-slider.ytmusic-player-bar {
  --paper-slider-container-color: rgba(255, 255, 255, 0.5) !important;
}
ytmusic-fullbleed-thumbnail-renderer img {
  mask: linear-gradient(to bottom, #000 0%, #000 50%, transparent 100%);
}
.background-gradient.style-scope,
ytmusic-app-layout[is-bauhaus-sidenav-enabled] #mini-guide-background.ytmusic-app-layout {
  background: var(--ytmusic-background) !important;
}
ytmusic-browse-response[has-background]:not([disable-gradient]) .background-gradient.ytmusic-browse-response {
  background: unset !important;
}
#background.immersive-background.style-scope.ytmusic-browse-response {
  opacity: 0.6;
}
ytmusic-search-box[is-bauhaus-sidenav-enabled] {
  --ytmusic-search-background: var(--ytmusic-color-black3) !important;
}
.${SEEKBAR_CLASS} #progress-bar.ytmusic-player-bar {
  --paper-slider-active-color: linear-gradient(
    to right,
    var(--paper-progress-active-color-1) 80%,
    var(--paper-progress-active-color-2) 100%
  ) !important;
  --paper-slider-knob-color: var(--paper-progress-active-color-1) !important;
  --paper-slider-knob-start-color: var(--paper-progress-active-color-2) !important;
}
`;

/* ------------------------------------------------------------------ *
 *  Переменные темы
 * ------------------------------------------------------------------ */
const VARIABLE_MAP: Record<string, string> = {
  '--ytmusic-color-black1': '#212121',
  '--ytmusic-color-black2': '#181818',
  '--ytmusic-color-black3': '#030303',
  '--ytmusic-color-black4': '#030303',
  '--ytmusic-color-blackpure': '#000',
  '--dark-theme-background-color': '#212121',
  '--yt-spec-base-background': '#0f0f0f',
  '--yt-spec-raised-background': '#212121',
  '--yt-spec-menu-background': '#282828',
  '--yt-spec-static-brand-black': '#212121',
  '--yt-spec-static-overlay-background-solid': '#000',
  '--yt-spec-static-overlay-background-heavy': 'rgba(0,0,0,0.8)',
  '--yt-spec-static-overlay-background-medium': 'rgba(0,0,0,0.6)',
  '--yt-spec-static-overlay-background-medium-light': 'rgba(0,0,0,0.3)',
  '--yt-spec-static-overlay-background-light': 'rgba(0,0,0,0.1)',
  '--yt-spec-general-background-a': '#181818',
  '--yt-spec-general-background-b': '#0f0f0f',
  '--yt-spec-general-background-c': '#030303',
  '--yt-spec-snackbar-background': '#030303',
  '--yt-spec-filled-button-text': '#030303',
  '--yt-spec-black-1': '#282828',
  '--yt-spec-black-2': '#1f1f1f',
  '--yt-spec-black-3': '#161616',
  '--yt-spec-black-4': '#0d0d0d',
  '--yt-spec-black-pure': '#000',
  '--yt-spec-black-pure-alpha-5': 'rgba(0,0,0,0.05)',
  '--yt-spec-black-pure-alpha-10': 'rgba(0,0,0,0.1)',
  '--yt-spec-black-pure-alpha-15': 'rgba(0,0,0,0.15)',
  '--yt-spec-black-pure-alpha-30': 'rgba(0,0,0,0.3)',
  '--yt-spec-black-pure-alpha-60': 'rgba(0,0,0,0.6)',
  '--yt-spec-black-pure-alpha-80': 'rgba(0,0,0,0.8)',
  '--yt-spec-black-1-alpha-98': 'rgba(40,40,40,0.98)',
  '--yt-spec-black-1-alpha-95': 'rgba(40,40,40,0.95)',
  '--paper-toast-background-color': '#323232',
  '--ytmusic-search-background': '#030303',
  '--paper-slider-knob-color': '#f03',
  '--paper-dialog-background-color': '#212121',
  '--paper-progress-active-color-1': '#f03',
  '--paper-progress-active-color-2': '#ff2791',
  '--yt-spec-inverted-background': '#f3f3f3',
  'background': 'rgba(3, 3, 3)',
  '--ytmusic-background': 'rgba(3, 3, 3)',
};

const COLOR_KEY_MAP: Record<string, string> = {
  'background': DARK_COLOR_KEY,
  '--ytmusic-background': DARK_COLOR_KEY,
};

const RATIO_MAP: Record<string, number> = {
  '--paper-progress-active-color-1': 1.75,
  '--paper-progress-active-color-2': 1.75,
  '--yt-spec-inverted-background': 1.75,
};

/* ------------------------------------------------------------------ *
 *  Цветовая математика (замена библиотеки "color")
 * ------------------------------------------------------------------ */
function rgbToHsl(r: number, g: number, b: number): RGB {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let hue = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue /= 6;
  }
  return [hue, s, l];
}

function hslToRgb(hue: number, s: number, l: number): RGB {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hue + 1 / 3), f(hue), f(hue - 1 / 3)].map((x) => Math.round(x * 255)) as RGB;
}

/** Аналог Color#darken: уменьшает светлость (HSL) на долю ratio */
function darken(rgb: RGB, ratio: number): RGB {
  const [hue, s, l] = rgbToHsl(...rgb);
  return hslToRgb(hue, s, l * (1 - ratio));
}

/** Относительная яркость по WCAG */
function luminosity([r, g, b]: RGB): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* ------------------------------------------------------------------ *
 *  Загрузка обложки и средний цвет
 * ------------------------------------------------------------------ */
async function defaultFetchImage(url: string): Promise<Blob> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch {
    // запасной путь: <img crossOrigin> -> canvas -> blob
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image load failed'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 64;
    canvas.height = img.naturalHeight || 64;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    );
  }
}

async function averageColor(
  url: string,
  fetchImage: (url: string) => Promise<Blob>,
): Promise<RGB | null> {
  const bitmap = await createImageBitmap(await fetchImage(url));
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, size, size);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 25) continue; // почти прозрачные пиксели пропускаем
    r += data[i] * data[i];
    g += data[i + 1] * data[i + 1];
    b += data[i + 2] * data[i + 2];
    n++;
  }
  if (!n) return null;
  return [Math.round(Math.sqrt(r / n)), Math.round(Math.sqrt(g / n)), Math.round(Math.sqrt(b / n))];
}

const noopController: AlbumColorController = {
  getConfig: () => ({ ...DEFAULT_CONFIG }),
  setConfig: () => {},
  destroy: () => {},
};

/* ------------------------------------------------------------------ *
 *  Основная функция
 * ------------------------------------------------------------------ */
export function initAlbumColor(options: AlbumColorOptions = {}): AlbumColorController {
  if (!isTopFrame()) return noopController;

  console.log('[Pear] Album color initializing...');

  const fetchImage = options.fetchImage ?? defaultFetchImage;
  const config = loadConfig(STORAGE_KEY, DEFAULT_CONFIG, options.config);
  config.ratio = clamp(config.ratio, 0, 1);

  let root: HTMLElement | null = null; // появится позже, см. whenRootReady
  let destroyed = false;
  const style = createStyle(STYLE);
  let lastKey = '';
  let lastTrack: Track | null = null;
  let token = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  /* ---------- переменные ---------- */
  const mixedColor = (color: string, key: string, ratioMultiply?: number): string => {
    const keyColor = `rgba(var(${key}), 1)`;
    let colorRatio = `var(${RATIO_KEY}, 50%)`;
    let originalRatio = `calc(100% - var(${RATIO_KEY}, 50%))`;
    if (ratioMultiply) {
      colorRatio = `calc(var(${RATIO_KEY}, 50%) * ${ratioMultiply})`;
      originalRatio = `calc(100% - calc(var(${RATIO_KEY}, 50%) * ${ratioMultiply}))`;
    }
    return `color-mix(in srgb, ${color} ${originalRatio}, ${keyColor} ${colorRatio})`;
  };

  const applyRatio = () => {
    root?.style.setProperty(RATIO_KEY, `${Math.round(config.ratio * 100)}%`);
  };

  const applySeekbar = () => {
    // класс на <html>, а не на <body>: body может ещё не существовать при раннем запуске
    root?.classList.toggle(SEEKBAR_CLASS, config.enabled && config.seekbar);
  };

  const applyVariables = () => {
    if (!root) return;
    for (const [variable, color] of Object.entries(VARIABLE_MAP)) {
      const key = COLOR_KEY_MAP[variable] ?? COLOR_KEY;
      root.style.setProperty(variable, mixedColor(color, key, RATIO_MAP[variable]), 'important');
    }
  };

  const setAlbumRgb = (color: string, dark: string) => {
    root?.style.setProperty(COLOR_KEY, color);
    root?.style.setProperty(DARK_COLOR_KEY, dark);
  };

  /* ---------- обновление цвета ---------- */
  const updateColor = async (track: Track) => {
    if (!root || !config.enabled) return;
    const current = ++token;

    let rgb: RGB | null = null;
    if (track.art) {
      try {
        rgb = await averageColor(track.art, fetchImage);
      } catch (err) {
        console.warn('[Pear] Album color: не удалось получить цвет обложки', err);
      }
    }
    if (current !== token || !config.enabled || destroyed) return; // трек уже сменился

    if (!rgb) {
      setAlbumRgb('0, 0, 0', '0, 0, 0');
      return;
    }

    let dark = darken(rgb, 0.3);
    let color = darken(rgb, 0.15);
    for (let i = 0; i < 100 && luminosity(color) > 0.5; i++) {
      color = darken(color, 0.05);
      dark = darken(dark, 0.05);
    }
    setAlbumRgb(color.join(', '), dark.join(', '));
  };

  /* ---------- включение / выключение ---------- */
  const enable = () => {
    if (!root) return;
    style.inject();
    applyVariables();
    applyRatio();
    applySeekbar();
    if (!root.style.getPropertyValue(COLOR_KEY)) setAlbumRgb('0, 0, 0', '0, 0, 0');
    if (lastTrack) void updateColor(lastTrack);
  };

  const disable = () => {
    token++;
    style.remove();
    if (root) {
      for (const variable of Object.keys(VARIABLE_MAP)) root.style.removeProperty(variable);
      root.style.removeProperty(COLOR_KEY);
      root.style.removeProperty(DARK_COLOR_KEY);
      root.style.removeProperty(RATIO_KEY);
      // не через applySeekbar: при destroy() config.enabled остаётся true и класс бы вернулся
      root.classList.remove(SEEKBAR_CLASS);
    }
  };

  /* ---------- отслеживание смены трека ---------- */
  const check = () => {
    const track = readTrack();
    if (!track) return;
    const key = `${track.title}|${track.artist}|${track.art}`;
    if (key === lastKey) return;
    lastKey = key;
    lastTrack = track;
    void updateColor(track);
  };

  // YouTube Music сам шлёт videodatachange — используем как ускоритель, основной путь — опрос
  const onVideoDataChange = () => check();

  /* ---------- запуск, когда появится <html> ---------- */
  const cancelWait = whenRootReady((el) => {
    if (destroyed) return;
    root = el;

    document.addEventListener('videodatachange', onVideoDataChange);
    timer = setInterval(check, 500);

    if (config.enabled) enable();
    check();

    console.log('[Pear] Album color active.');
  });

  return {
    getConfig: () => ({ ...config }),

    setConfig(patch) {
      const wasEnabled = config.enabled;
      Object.assign(config, patch);
      config.ratio = clamp(Number(config.ratio) || 0, 0, 1);
      saveConfig(STORAGE_KEY, config);

      if (!root || destroyed) return; // применится при старте

      if (config.enabled && !wasEnabled) enable();
      else if (!config.enabled && wasEnabled) disable();
      else if (config.enabled) {
        applyRatio();
        applySeekbar();
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelWait();
      if (timer) clearInterval(timer);
      timer = undefined;
      document.removeEventListener('videodatachange', onVideoDataChange);
      disable();
    },
  };
}