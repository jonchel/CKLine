// Ядро расчётов: почасовая и сменная выработка по замерам счётчиков.
// Чистые функции без зависимостей — тестируются изолированно (см. core.test.mjs).

/**
 * Одна линия станка в отчёте: все замеры по станку+операции.
 * entries: [{ machine_id, operation, counter_value, recorded_at, kind }]
 *
 * Правила:
 *  - мастер переписывает значение СЧЁТЧИКА на текущий момент (накопленное);
 *  - выработка за интервал = разность соседних замеров;
 *  - падение счётчика (переналадка/сброс) = новый отсчёт от нуля;
 *  - «за час / накоплено» считается на конец часа по последнему замеру.
 */

// Все временные операции — в локальном часовом поясе телефона мастера:
// и замеры, и границы часов переводятся одинаково, поэтому сравнения корректны
// независимо от того, в каком виде хранится recorded_at.
const time = (v) => new Date(v).getTime();

export function groupEntries(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.kind && e.kind !== "counter") continue;
    const key = `${e.machine_id}|${e.operation}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  for (const list of map.values()) {
    list.sort((a, b) => time(a.recorded_at) - time(b.recorded_at));
  }
  return map;
}

/** Суммарная выработка по группе замеров одного тока с учётом сбросов счётчика. */
export function totalProduced(sortedEntries) {
  let total = 0;
  let prev = null;
  for (const e of sortedEntries) {
    const v = Number(e.counter_value ?? 0);
    if (prev === null || v < prev) total += v; // первый замер или сброс после переналадки
    else total += v - prev;
    prev = v;
  }
  return total;
}

/**
 * Значения для строки отчёта на момент asOf (конец часа):
 *  - accumulated: показание счётчика последнего замера до asOf;
 *  - perHour: изготовлено за час [hourStart, hourEnd).
 * Первый замер часа сравнивается с последним замером ДО часа — поэтому
 * прирост, случившийся между обходами, не теряется и не удваивается.
 */
export function hourStats(sortedEntries, hourStart, hourEnd) {
  const ts = time(hourStart);
  const te = time(hourEnd);
  const inHour = sortedEntries.filter(
    (e) => time(e.recorded_at) >= ts && time(e.recorded_at) < te,
  );
  const before = sortedEntries.filter((e) => time(e.recorded_at) < ts);
  const lastBefore = before.length ? before[before.length - 1] : null;
  const upto = sortedEntries.filter((e) => time(e.recorded_at) < te);
  const lastUpTo = upto.length ? upto[upto.length - 1] : null;

  const accumulated = lastUpTo ? Number(lastUpTo.counter_value) : 0;

  // Выработка за час: разности замеров внутри часа;
  // база для первого замера — последний замер до часа (или 0, если это начало смены).
  let perHour = 0;
  let prev = lastBefore ? Number(lastBefore.counter_value) : null;
  for (const e of inHour) {
    const v = Number(e.counter_value ?? 0);
    if (prev !== null && v < prev) perHour += v;      // сброс после переналадки — от нуля
    else if (prev === null) perHour += v;             // первый в жизни замер — от нуля
    else perHour += Math.max(v - prev, 0);            // обычная разность
    prev = v;
  }
  return { perHour, accumulated };
}

/** Формат «за час / накоплено», как в исходном отчёте: Ток 3 — 4/7шт. */
export function formatPair(perHour, accumulated) {
  return `${perHour}/${accumulated}шт.`;
}
