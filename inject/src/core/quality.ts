/**
 * Качество видео плеера YouTube Music: подписи уровней и меню выбора.
 * Общее для кнопки качества в плеере и в ленте сэмплов.
 *
 * Плеер запоминает выбранное качество (setPlaybackQualityRange) для всего
 * YouTube Music, как настройка качества в обычном YouTube.
 */

import { h, svgIcon } from './index';

/** уровни качества плеера YouTube → подписи; порядок — от лучшего к худшему */
export const QUALITY_LABELS: Record<string, string> = {
  hd2160: '2160p',
  hd1440: '1440p',
  hd1080: '1080p',
  hd720: '720p',
  large: '480p',
  medium: '360p',
  small: '240p',
  tiny: '144p',
};

export interface QualityPlayer extends HTMLElement {
  getVideoData(): { video_id?: string };
  /** качество (hd1080, hd720, large…) или 'auto' */
  setPlaybackQualityRange?(min: string, max: string): void;
  getUserPlaybackQualityPreference?(): string;
  getAvailableQualityData?(): { quality: string; qualityLabel: string; isPlayable: boolean }[];
  getPlaybackQualityLabel?(): string;
}

export const qualityLabel = (q: string) => (q === 'auto' ? 'Авто' : QUALITY_LABELS[q] ?? q);

export const isQuality = (q: string) => q === 'auto' || q in QUALITY_LABELS;

/** три ползунка — в той же манере, что иконки YouTube Music */
export const QUALITY_ICON =
  'M3 5a1 1 0 011-1h9.17a3.001 3.001 0 015.66 0H20a1 1 0 110 2h-1.17a3.001 3.001 0 01-5.66 0H4a1 1 0 01-1-1Zm13-1a1 1 0 100 2 1 1 0 000-2Z' +
  'M3 12a1 1 0 011-1h1.17a3.001 3.001 0 015.66 0H20a1 1 0 110 2h-9.17a3.001 3.001 0 01-5.66 0H4a1 1 0 01-1-1Zm5-1a1 1 0 100 2 1 1 0 000-2Z' +
  'M3 19a1 1 0 011-1h7.17a3.001 3.001 0 015.66 0H20a1 1 0 110 2h-3.17a3.001 3.001 0 01-5.66 0H4a1 1 0 01-1-1Zm11-1a1 1 0 100 2 1 1 0 000-2Z';

const CHECK_ICON = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';

/** Внешний вид меню — как всплывающие меню YouTube Music */
export const QUALITY_MENU_CSS = `
.pear-qmenu { min-width: 200px; padding: 8px 0; border-radius: 8px; background: var(--yt-spec-menu-background, #282828); box-shadow: 0 4px 32px rgba(0,0,0,.6); color: #fff; font: 400 14px Roboto, "Noto Naskh Arabic UI", Arial, sans-serif; user-select: none; }
.pear-qmenu[hidden] { display: none; }
.pear-qmenu-title { padding: 8px 16px 8px 52px; font-size: 12px; line-height: 16px; color: rgba(255,255,255,.7); }
.pear-qmenu button { display: flex; align-items: center; width: 100%; height: 40px; gap: 12px; margin: 0; padding: 0 16px; border: 0; border-radius: 0; background: none; color: #fff; font: inherit; cursor: pointer; white-space: nowrap; }
.pear-qmenu button:hover { background: rgba(255,255,255,.1); }
.pear-qmenu svg { width: 24px; height: 24px; fill: currentColor; flex: none; visibility: hidden; }
.pear-qmenu button[aria-checked='true'] svg { visibility: visible; }
.pear-qmenu-empty { padding: 8px 16px; color: rgba(255,255,255,.7); white-space: nowrap; }
`;

/**
 * Заполняет меню пунктами качества. `loaded` — плеер играет нужное видео
 * (не рекламу): тогда список берётся у самого видео, иначе стандартный.
 */
export function renderQualityMenu(
  menu: HTMLElement,
  opts: { player: QualityPlayer | null; loaded: boolean; selected: string; onPick: (q: string) => void },
): void {
  const { player, loaded, selected, onPick } = opts;
  const available = loaded ? (player?.getAvailableQualityData?.() ?? []).filter((d) => d.isPlayable) : null;
  const levels = available
    ? available.map((d) => d.quality).filter((q) => QUALITY_LABELS[q])
    : Object.keys(QUALITY_LABELS).filter((q) => q !== 'hd2160' && q !== 'hd1440');

  const item = (q: string, label: string) =>
    h(
      'button',
      {
        role: 'menuitemradio',
        'aria-checked': String(selected === q),
        onclick: (e: Event) => {
          e.stopPropagation();
          onPick(q);
        },
      },
      svgIcon(CHECK_ICON),
      label,
    );
  const current = loaded ? player?.getPlaybackQualityLabel?.() : '';
  menu.replaceChildren(
    h('div', { class: 'pear-qmenu-title' }, 'Качество'),
    item('auto', current ? `Авто (${current})` : 'Авто'),
    ...(levels.length
      ? levels.map((q) => item(q, available?.find((d) => d.quality === q)?.qualityLabel ?? QUALITY_LABELS[q]))
      : [h('div', { class: 'pear-qmenu-empty' }, 'У этого трека нет видео')]),
  );
}
