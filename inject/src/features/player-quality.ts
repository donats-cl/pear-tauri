/**
 * Кнопка качества видео в плеере YouTube Music — рядом с кнопкой
 * «На весь экран» в ряду кнопок поверх клипа на странице плеера.
 *
 * Использование (в точке входа inject-бандла):
 *
 *   import { initPlayerQuality } from './features/player-quality';
 *   initPlayerQuality();
 *
 * Выбор сохраняет сам плеер (как настройка качества в обычном YouTube),
 * поэтому он действует на все следующие клипы.
 */

import { createStyle, h, isTopFrame, svgIcon, whenRootReady } from '../core';
import {
  QUALITY_ICON,
  QUALITY_MENU_CSS,
  qualityLabel,
  renderQualityMenu,
  type QualityPlayer,
} from '../core/quality';

const BUTTON_CLASS = 'pear-quality-button';
const MENU_ID = 'pear-player-quality-menu';
const POLL_MS = 1000;
/** отступ меню от кнопки и от краёв окна, px */
const GAP = 8;

const STYLE = `
.${BUTTON_CLASS} { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin: 0 0 0 8px; padding: 0; border: 0; background: none; color: #fff; cursor: pointer; }
.${BUTTON_CLASS} svg { width: 24px; height: 24px; fill: currentColor; }
#${MENU_ID} { position: fixed; z-index: 2300; }
${QUALITY_MENU_CSS}
`;

const getPlayer = () => document.querySelector<QualityPlayer>('#movie_player');

export function initPlayerQuality(): { destroy(): void } {
  if (!isTopFrame()) return { destroy: () => {} };

  const style = createStyle(STYLE);
  let timer: ReturnType<typeof setInterval> | undefined;
  let menu: HTMLElement | null = null;
  let anchor: HTMLElement | null = null;

  const selected = () => getPlayer()?.getUserPlaybackQualityPreference?.() || 'auto';

  const updateTitles = () => {
    const title = `Качество: ${qualityLabel(selected())}`;
    for (const b of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      b.setAttribute('title', title);
      b.setAttribute('aria-label', title);
    }
  };

  /* ---------- меню ---------- */
  const close = () => {
    if (!menu) return;
    menu.hidden = true;
    anchor = null;
  };

  // меню прижато к правому краю кнопки, под ней; если не влезает — над ней
  const place = () => {
    if (!menu || !anchor) return;
    const b = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const left = Math.min(Math.max(GAP, b.right - m.width), window.innerWidth - m.width - GAP);
    let top = b.bottom + GAP;
    if (top + m.height > window.innerHeight - GAP) top = Math.max(GAP, b.top - m.height - GAP);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  const open = (button: HTMLElement) => {
    if (!menu) {
      menu = h('div', { id: MENU_ID, class: 'pear-qmenu', role: 'menu', 'aria-label': 'Качество' });
      document.body.append(menu);
    }
    const player = getPlayer();
    renderQualityMenu(menu, {
      player,
      loaded: !!player?.getVideoData()?.video_id && !player.classList.contains('ad-showing'),
      selected: selected(),
      onPick: (q) => {
        // плеер запоминает выбор для всех следующих клипов
        getPlayer()?.setPlaybackQualityRange?.(q, q);
        updateTitles();
        close();
      },
    });
    anchor = button;
    menu.hidden = false;
    place();
  };

  const onButton = (e: Event) => {
    // клик по клипу ставит паузу — не пускаем событие дальше
    e.stopPropagation();
    e.preventDefault();
    const button = e.currentTarget as HTMLElement;
    if (menu && !menu.hidden && anchor === button) close();
    else open(button);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!menu || menu.hidden) return;
    const t = e.target as Element;
    if (!menu.contains(t) && !t.closest(`.${BUTTON_CLASS}`)) close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && menu && !menu.hidden) {
      e.stopPropagation();
      close();
    }
  };

  /* ---------- кнопка рядом с «На весь экран» ---------- */
  const makeButton = () => {
    const b = h('button', { class: BUTTON_CLASS, type: 'button' }, svgIcon(QUALITY_ICON));
    b.addEventListener('click', onButton);
    // YouTube Music реагирует на нажатие по области клипа ещё до click
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  };

  // плеер может перерисовать ряд кнопок — проверяем периодически
  const ensure = () => {
    for (const row of document.querySelectorAll('ytmusic-player .top-row-buttons')) {
      if (row.querySelector(`.${BUTTON_CLASS}`)) continue;
      const fullscreen = row.querySelector('.fullscreen-button');
      row.insertBefore(makeButton(), fullscreen);
    }
    if (anchor && !anchor.isConnected) close();
    updateTitles();
  };

  const cancelWait = whenRootReady(() => {
    style.inject();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    timer = setInterval(ensure, POLL_MS);
    ensure();
  });

  return {
    destroy() {
      cancelWait();
      if (timer) clearInterval(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
      for (const b of document.querySelectorAll(`.${BUTTON_CLASS}`)) b.remove();
      menu?.remove();
      menu = null;
      style.remove();
    },
  };
}
