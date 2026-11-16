import { addJsonVisitor, applyJsonVisitors } from '../core/json-hooks';

export function initAdblock() {
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];

  addJsonVisitor((node) => {
    for (const key of AD_KEYS) if (key in node) delete node[key];
  });

  // inline-данные в HTML страницы
  let initial: any;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initial,
      set: (v) => { initial = applyJsonVisitors(v); },
    });
  } catch {}
}
