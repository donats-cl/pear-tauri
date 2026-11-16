/**
 * Убирает кнопку «Подписка» / «Upgrade» (реклама YouTube Music Premium)
 * из бокового меню, свёрнутого меню и нижней панели узкого окна.
 *
 * Пункт меню опознаётся по данным Polymer-элемента (browseId = SPunlimited),
 * а не по тексту — так работает на любом языке интерфейса.
 */

import { createStyle, isTopFrame, whenRootReady } from '../core';

const UPGRADE_BROWSE_ID = 'SPunlimited';
const HIDDEN_ATTR = 'pear-upgrade';
const POLL_MS = 1000;

const STYLE = `
[${HIDDEN_ATTR}],
ytmusic-pivot-bar-item-renderer[tab-id='${UPGRADE_BROWSE_ID}'] {
  display: none !important;
}
`;

type GuideEntry = Element & {
  data?: { navigationEndpoint?: { browseEndpoint?: { browseId?: string } } };
};

const isUpgrade = (el: GuideEntry) =>
  el.data?.navigationEndpoint?.browseEndpoint?.browseId === UPGRADE_BROWSE_ID ||
  !!el.querySelector('a[href*="music_premium"], a[href*="SPunlimited"]');

export function initHideUpgrade(): { destroy(): void } {
  if (!isTopFrame()) return { destroy: () => {} };

  const style = createStyle(STYLE);
  let timer: ReturnType<typeof setInterval> | undefined;

  // меню перерисовывается при смене аккаунта и размера окна — проверяем периодически
  const mark = () => {
    for (const el of document.querySelectorAll<GuideEntry>('ytmusic-guide-entry-renderer')) {
      el.toggleAttribute(HIDDEN_ATTR, isUpgrade(el));
    }
  };

  const cancelWait = whenRootReady(() => {
    style.inject();
    mark();
    timer = setInterval(mark, POLL_MS);
  });

  return {
    destroy() {
      cancelWait();
      if (timer) clearInterval(timer);
      style.remove();
      for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) el.removeAttribute(HIDDEN_ATTR);
    },
  };
}
