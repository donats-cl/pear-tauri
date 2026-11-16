/**
 * Общие утилиты для фич inject-бандла.
 */

/** Скрипт попадает и в подфреймы (about:blank, рекламные и служебные iframe) — там фичи не нужны */
export const isTopFrame = () => window.self === window.top;

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/* ------------------------------------------------------------------ *
 *  DOM
 * ------------------------------------------------------------------ */
export type Child = Node | string | number;

// Без innerHTML — на странице включены Trusted Types
export function h(tag: string, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** SVG-иконка 24×24 по пути `d` (иконки в стиле YouTube Music) */
export function svgIcon(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

/* ------------------------------------------------------------------ *
 *  Пункты в боковом меню YouTube Music (после «Главная / Навигатор / Библиотека»)
 * ------------------------------------------------------------------ */
const GUIDE_ENTRY_CLASS = 'pear-guide-entry';

export const GUIDE_ENTRY_CSS = `
.${GUIDE_ENTRY_CLASS} { display: flex; align-items: center; height: 48px; padding: 0 16px; border-radius: 8px; cursor: pointer; color: #fff; font: 400 16px/24px Roboto, "Noto Naskh Arabic UI", Arial, sans-serif; user-select: none; }
.${GUIDE_ENTRY_CLASS}:hover { background: rgba(255,255,255,.1); }
.${GUIDE_ENTRY_CLASS} svg { width: 24px; height: 24px; margin-right: 20px; flex: none; fill: currentColor; }
#mini-guide .${GUIDE_ENTRY_CLASS} { flex-direction: column; justify-content: center; height: auto; padding: 12px 0; font-size: 10px; line-height: 14px; }
#mini-guide .${GUIDE_ENTRY_CLASS} svg { margin: 0 0 5px; }
`;

/**
 * Добавляет пункт в обе версии меню (полное и свёрнутое), если его там нет.
 * Меню перерисовывается при смене аккаунта и размера окна — вызывать периодически.
 */
export function ensureGuideEntry(id: string, iconPath: string, label: string, onClick: () => void): void {
  for (const items of document.querySelectorAll('#guide ytmusic-guide-section-renderer #items, #mini-guide ytmusic-guide-section-renderer #items')) {
    // только первая секция (Главная / Навигатор / Библиотека)
    if (items.closest('ytmusic-guide-section-renderer')?.previousElementSibling?.matches('ytmusic-guide-section-renderer')) continue;
    if (items.querySelector(`:scope > [data-pear-entry="${id}"]`)) continue;
    const el = h('div', { class: GUIDE_ENTRY_CLASS, role: 'link', tabindex: '0', 'data-pear-entry': id, onclick: onClick }, svgIcon(iconPath), h('span', {}, label));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onClick();
    });
    items.append(el);
  }
}

export function removeGuideEntry(id: string): void {
  for (const el of document.querySelectorAll(`[data-pear-entry="${id}"]`)) el.remove();
}

/* ------------------------------------------------------------------ *
 *  Вызов Rust-команд
 * ------------------------------------------------------------------ */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  }
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI_INTERNALS__;
  if (!t) throw new Error('Tauri IPC недоступен (проверьте capabilities → remote urls)');
  try {
    return (await t.invoke(cmd, args)) as T;
  } catch (err) {
    // Tauri отклоняет промис строкой (Err(String) из Rust или ошибка ACL), а не Error
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : JSON.stringify(err);
    throw new Error(`${cmd}: ${msg}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Текущий трек
 * ------------------------------------------------------------------ */
export interface Track {
  title: string;
  artist: string;
  album: string;
  art: string;
}

export const getVideo = () => document.querySelector('video');

export function readTrack(): Track | null {
  const md = navigator.mediaSession?.metadata;
  if (md?.title) {
    const art = md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    return { title: md.title, artist: md.artist, album: md.album, art };
  }

  // запасной вариант — DOM плеера
  const bar = document.querySelector('ytmusic-player-bar');
  const title = bar?.querySelector('.title')?.textContent?.trim();
  if (!bar || !title) return null;
  const byline = (bar.querySelector('.byline')?.textContent ?? '').split('•').map((s) => s.trim());
  const art = bar.querySelector('img')?.src ?? '';
  return { title, artist: byline[0] ?? '', album: byline[1] ?? '', art };
}

/* ------------------------------------------------------------------ *
 *  Ожидание корневого элемента
 *  initialization_script выполняется ДО создания <html>, поэтому
 *  document.documentElement в этот момент равен null.
 * ------------------------------------------------------------------ */
export function whenRootReady(cb: (root: HTMLElement) => void): () => void {
  if (document.documentElement) {
    cb(document.documentElement);
    return () => {};
  }

  let done = false;
  const finish = () => {
    if (done || !document.documentElement) return;
    done = true;
    observer.disconnect();
    document.removeEventListener('DOMContentLoaded', finish);
    cb(document.documentElement);
  };
  const observer = new MutationObserver(finish);
  observer.observe(document, { childList: true });
  document.addEventListener('DOMContentLoaded', finish);

  return () => {
    done = true;
    observer.disconnect();
    document.removeEventListener('DOMContentLoaded', finish);
  };
}

/* ------------------------------------------------------------------ *
 *  Стили: adoptedStyleSheets, запасной путь — <style>
 * ------------------------------------------------------------------ */
export interface StyleHandle {
  inject(): void;
  remove(): void;
}

export function createStyle(css: string): StyleHandle {
  let sheet: CSSStyleSheet | null = null;
  let styleEl: HTMLStyleElement | null = null;

  return {
    inject() {
      if (sheet || styleEl) return;
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      } catch {
        sheet = null;
        styleEl = document.createElement('style');
        styleEl.textContent = css;
        (document.head ?? document.documentElement).append(styleEl);
      }
    },
    remove() {
      if (sheet) {
        const s = sheet;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
        sheet = null;
      }
      styleEl?.remove();
      styleEl = null;
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Хранилище настроек
 *  Из localStorage берутся только известные ключи с тем же типом,
 *  что и в значениях по умолчанию, — испорченные данные игнорируются.
 * ------------------------------------------------------------------ */
export function loadConfig<T extends object>(key: string, defaults: T, initial: Partial<T> = {}): T {
  const config: T = { ...defaults, ...initial };
  try {
    const raw = localStorage.getItem(key);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(defaults) as (keyof T)[]) {
        const v = (stored as Partial<T>)[k];
        if (typeof v === typeof defaults[k] && (typeof v !== 'number' || Number.isFinite(v))) config[k] = v as T[keyof T];
      }
    }
  } catch {
    /* хранилище может быть недоступно */
  }
  return config;
}

export function saveConfig(key: string, config: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}
