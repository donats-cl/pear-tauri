/**
 * Правка ответов YouTube до того, как их увидит страница.
 *
 * YouTube Music получает данные как JSON — через JSON.parse (встроенные в HTML
 * данные, ответы, прочитанные как текст) и Response#json (fetch). Оба пути
 * перехватываются один раз, и каждый объект ответа один раз проходит через
 * все зарегистрированные обработчики (реклама, вкладка комментариев и т. п.).
 */

/** Вызывается для каждого объекта (не массива) в ответе; может менять его на месте */
export type JsonVisitor = (node: Record<string, any>) => void;

const visitors: JsonVisitor[] = [];
// один и тот же объект не обходим повторно (ответ может пройти и через parse, и через json)
const seen = new WeakSet<object>();
let installed = false;

function walk(o: unknown): void {
  if (!o || typeof o !== 'object' || seen.has(o)) return;
  seen.add(o);
  if (!Array.isArray(o)) for (const v of visitors) v(o as Record<string, any>);
  for (const key of Object.keys(o)) walk((o as Record<string, unknown>)[key]);
}

/** Прогоняет готовый объект через обработчики (для данных, пришедших в обход JSON.parse) */
export function applyJsonVisitors<T>(o: T): T {
  walk(o);
  return o;
}

function install(): void {
  if (installed) return;
  installed = true;

  const originalParse = JSON.parse;
  JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    return applyJsonVisitors(originalParse.call(JSON, text, reviver));
  };

  const originalJson = Response.prototype.json;
  Response.prototype.json = function () {
    return originalJson.call(this).then(applyJsonVisitors);
  };
}

export function addJsonVisitor(visitor: JsonVisitor): void {
  visitors.push(visitor);
  install();
}
