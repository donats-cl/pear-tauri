/**
 * Ambient mode — свечение вокруг плеера по цветам видео / обложки
 * (аналог плагина ambient-mode из pear-desktop, MIT) для Tauri: без Electron, без Node.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initAmbientMode } from './features/ambient-mode';
 *   const ambient = initAmbientMode();
 *   // ambient.setConfig({ blur: 120, opacity: 0.8 });
 *   // ambient.destroy();
 *
 * Как работает: раз в `interpolationTime` мс кадр видео (или обложка в режиме «Песня»)
 * рисуется в маленький canvas (`quality` px по ширине), затем плавно
 * проявляется поверх предыдущего кадра. Размытие делается CSS-фильтром,
 * пиксели canvas не читаются, поэтому CORS обложек не мешает.
 */

import { clamp, createStyle, isTopFrame, loadConfig, saveConfig, whenRootReady } from '../core';

export interface AmbientModeConfig {
  /** Включён ли режим */
  enabled: boolean;
  /** Ширина canvas для выборки кадра, px (меньше = быстрее и «мягче») */
  quality: number;
  /** Время плавного перехода между кадрами, мс (он же интервал выборки) */
  interpolationTime: number;
  /** Размытие, px */
  blur: number;
  /** Размер свечения относительно плеера, % */
  size: number;
  /** Прозрачность свечения, 0..1 */
  opacity: number;
  /** Показывать в полноэкранном режиме */
  fullscreen: boolean;
}

export interface AmbientModeController {
  getConfig(): AmbientModeConfig;
  setConfig(patch: Partial<AmbientModeConfig>): void;
  destroy(): void;
}

const STORAGE_KEY = 'pear:ambient-mode';
const ROOT_ID = 'pear-ambient';
const ON_CLASS = 'pear-ambient-on';

const DEFAULT_CONFIG: AmbientModeConfig = {
  enabled: true,
  quality: 50,
  interpolationTime: 1500,
  blur: 100,
  size: 100,
  opacity: 1,
  fullscreen: false,
};

/* ------------------------------------------------------------------ *
 *  CSS
 *  Свечение лежит на z-index: -1 под всем интерфейсом, поэтому пока
 *  режим активен, фоны основных контейнеров делаются прозрачными.
 *  Если на вашей версии YouTube Music что-то перекрывает свечение —
 *  добавьте селектор в список ниже.
 * ------------------------------------------------------------------ */
const STYLE = `
#${ROOT_ID} {
  display: none;
  position: fixed;
  z-index: -1;
  pointer-events: none;
  opacity: var(--pear-ambient-opacity, 1);
  filter: blur(var(--pear-ambient-blur, 100px));
  transition: opacity 300ms;
}
#${ROOT_ID} canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
html.${ON_CLASS} {
  background-color: #030303;
}
html.${ON_CLASS} #${ROOT_ID} {
  display: block;
}
html.${ON_CLASS} body,
html.${ON_CLASS} ytmusic-app,
html.${ON_CLASS} ytmusic-app-layout,
html.${ON_CLASS} ytmusic-app-layout #player-page,
html.${ON_CLASS} ytmusic-app-layout #content,
html.${ON_CLASS} ytmusic-player-page,
html.${ON_CLASS} #player-page,
html.${ON_CLASS} #main-panel,
html.${ON_CLASS} #side-panel {
  background: transparent !important;
}
`;

function normalize(config: AmbientModeConfig): void {
  config.quality = clamp(config.quality, 8, 200);
  config.interpolationTime = clamp(config.interpolationTime, 100, 10000);
  config.blur = clamp(config.blur, 0, 300);
  config.size = clamp(config.size, 50, 300);
  config.opacity = clamp(config.opacity, 0, 1);
}

const noopController: AmbientModeController = {
  getConfig: () => ({ ...DEFAULT_CONFIG }),
  setConfig: () => {},
  destroy: () => {},
};

/* ------------------------------------------------------------------ *
 *  Источник кадра: обложка (режим «Песня») или видео
 * ------------------------------------------------------------------ */
interface Frame {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** элемент, по которому считается положение свечения */
  anchor: Element;
}

function readFrame(): Frame | null {
  // режим «Песня»: видна обложка
  const songImage = document.querySelector('#song-image');
  const img = songImage?.querySelector('img');
  if (songImage && img && img.complete && img.naturalWidth > 0 && songImage.getBoundingClientRect().width > 0) {
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, anchor: songImage };
  }

  // режим «Видео»
  const video = document.querySelector<HTMLVideoElement>('#song-video video, ytmusic-player video');
  if (video && video.readyState >= 2 && video.videoWidth > 0) {
    return { source: video, width: video.videoWidth, height: video.videoHeight, anchor: video };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Основная функция
 * ------------------------------------------------------------------ */
export function initAmbientMode(options: { config?: Partial<AmbientModeConfig> } = {}): AmbientModeController {
  if (!isTopFrame()) return noopController;

  console.log('[Pear] Ambient mode initializing...');

  const config = loadConfig(STORAGE_KEY, DEFAULT_CONFIG, options.config);
  normalize(config);

  let root: HTMLElement | null = null; // <html>, появится позже, см. whenRootReady
  let destroyed = false;
  let active = false;

  const style = createStyle(STYLE);

  let box: HTMLElement | null = null; // контейнер свечения
  let layers: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
  let top = 0; // индекс canvas, который сейчас сверху
  let hasFrame = false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | null = null;
  let lastAnchor: Element | null = null;

  /* ---------- DOM ---------- */
  const buildDom = () => {
    if (box) return;
    const mkCanvas = (z: number) => {
      const c = document.createElement('canvas');
      c.style.zIndex = String(z);
      return c;
    };
    layers = [mkCanvas(1), mkCanvas(2)];
    top = 1;
    box = document.createElement('div');
    box.id = ROOT_ID;
    box.setAttribute('aria-hidden', 'true');
    box.append(...layers);
    // body может ещё не существовать при раннем запуске
    (document.body ?? root!).prepend(box);
  };

  const destroyDom = () => {
    box?.remove();
    box = null;
    layers = null;
    hasFrame = false;
  };

  const applyVars = () => {
    if (!box) return;
    box.style.setProperty('--pear-ambient-blur', `${config.blur}px`);
    box.style.setProperty('--pear-ambient-opacity', String(config.opacity));
  };

  /* ---------- состояние плеера ---------- */
  const isPlayerOpen = () => {
    const layout = document.querySelector('ytmusic-app-layout');
    return !!layout && (layout.hasAttribute('player-page-open_') || layout.hasAttribute('player-page-open'));
  };

  const isFullscreen = () => !!document.querySelector("ytmusic-player[player-ui-state='FULLSCREEN']");

  const shouldShow = () => isPlayerOpen() && !document.hidden && (config.fullscreen || !isFullscreen());

  /* ---------- положение свечения ---------- */
  const place = (anchor: Element) => {
    if (!box) return;
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const k = config.size / 100;
    const w = r.width * k;
    const hgt = r.height * k;
    box.style.left = `${r.left - (w - r.width) / 2}px`;
    box.style.top = `${r.top - (hgt - r.height) / 2}px`;
    box.style.width = `${w}px`;
    box.style.height = `${hgt}px`;
  };

  const watchAnchor = (anchor: Element) => {
    if (lastAnchor === anchor) return;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => place(anchor));
    resizeObserver.observe(anchor);
    lastAnchor = anchor;
  };

  /* ---------- выборка кадра и плавный переход ---------- */
  const sample = () => {
    if (!box || !layers || !root) return;

    const show = shouldShow();
    root.classList.toggle(ON_CLASS, show);
    if (!show) return;

    const frame = readFrame();
    if (!frame) return;

    watchAnchor(frame.anchor);
    place(frame.anchor);

    // рисуем в нижний canvas, потом поднимаем его наверх и проявляем
    const next = hasFrame ? 1 - top : top;
    const canvas = layers[next];
    const w = Math.max(8, Math.round(config.quality));
    const hgt = Math.max(8, Math.round((w * frame.height) / frame.width));
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(frame.source, 0, 0, w, hgt);
    } catch {
      return; // кадр временно недоступен
    }

    if (!hasFrame) {
      hasFrame = true;
      canvas.style.transition = 'none';
      canvas.style.opacity = '1';
      return;
    }

    const prev = layers[top];
    prev.style.zIndex = '1';
    prev.style.opacity = '1';
    canvas.style.zIndex = '2';
    canvas.style.transition = 'none';
    canvas.style.opacity = '0';
    void canvas.offsetWidth; // перезапуск transition
    canvas.style.transition = `opacity ${config.interpolationTime}ms linear`;
    canvas.style.opacity = '1';
    top = next;
  };

  const loop = () => {
    if (destroyed || !active) return;
    sample();
    timer = setTimeout(loop, clamp(config.interpolationTime, 100, 10000));
  };

  const onVisibility = () => sample();
  const onResize = () => {
    if (lastAnchor) place(lastAnchor);
  };

  /* ---------- включение / выключение ---------- */
  const enable = () => {
    if (active || !root || destroyed) return;
    active = true;
    style.inject();
    buildDom();
    applyVars();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    loop();
  };

  const disable = () => {
    active = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onResize);
    resizeObserver?.disconnect();
    resizeObserver = null;
    lastAnchor = null;
    root?.classList.remove(ON_CLASS);
    destroyDom();
    style.remove();
  };

  /* ---------- запуск, когда появится <html> ---------- */
  const cancelWait = whenRootReady((el) => {
    if (destroyed) return;
    root = el;
    if (config.enabled) enable();
    console.log('[Pear] Ambient mode active.');
  });

  return {
    getConfig: () => ({ ...config }),

    setConfig(patch) {
      const wasEnabled = config.enabled;
      Object.assign(config, patch);
      normalize(config);
      saveConfig(STORAGE_KEY, config);

      if (!root || destroyed) return; // применится при старте

      if (config.enabled && !wasEnabled) enable();
      else if (!config.enabled && wasEnabled) disable();
      else if (config.enabled) {
        applyVars();
        if (lastAnchor) place(lastAnchor);
      }
    },

    destroy() {
      destroyed = true;
      cancelWait();
      disable();
    },
  };
}
