/**
 * Убирает вкладку «Комментарии» на странице плеера YouTube Music.
 *
 * Вкладка вырезается прямо из ответа YouTube, поэтому YouTube Music её
 * не рисует вовсе. Опознаётся по данным, а не по названию (оно зависит
 * от языка): у неё нет ссылки на страницу, а содержимое подгружается
 * продолжением — в отличие от «Далее» (очередь), «Текста» и «Похожего».
 */

import { addJsonVisitor } from '../core/json-hooks';

type Tab = { tabRenderer?: { endpoint?: unknown; content?: { sectionListRenderer?: { continuations?: unknown[] } } } };

const isCommentsTab = (t: Tab) => {
  const r = t?.tabRenderer;
  if (!r || r.endpoint) return false;
  const list = r.content?.sectionListRenderer;
  return !!list?.continuations?.some((c) => !!c && typeof c === 'object' && 'reloadContinuationData' in c);
};

export function initHideComments(): void {
  addJsonVisitor((node) => {
    const tabbed = node.watchNextTabbedResultsRenderer;
    if (!tabbed || !Array.isArray(tabbed.tabs)) return;
    tabbed.tabs = tabbed.tabs.filter((t: Tab) => !isCommentsTab(t));
  });
}
