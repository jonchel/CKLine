// Тесты ядра расчётов и генератора отчёта.
// Запуск: node src/lib/core.test.mjs
import assert from "node:assert/strict";
import { groupEntries, hourStats, totalProduced, formatPair } from "./core.js";
import { renderReport } from "./report.js";

const t = (s) => new Date(`2026-10-03T${s}:00+03:00`).toISOString();

// --- Пример заказчика: 9:00–10:00 Ток1 = 2/2; 10:00–11:00 Ток1 = 3/5 ---
const e1 = { machine_id: "m1", operation: "Ток 1", counter_value: 2, recorded_at: t("09:30"), kind: "counter" };
const e2 = { machine_id: "m1", operation: "Ток 1", counter_value: 5, recorded_at: t("10:40"), kind: "counter" };
const g = groupEntries([e1, e2]);
const list = g.get("m1|Ток 1");

let s = hourStats(list, new Date(t("09:00")), new Date(t("10:00")));
assert.equal(s.perHour, 2);
assert.equal(s.accumulated, 2);
assert.equal(formatPair(s.perHour, s.accumulated), "2/2шт.");

s = hourStats(list, new Date(t("10:00")), new Date(t("11:00")));
assert.equal(s.perHour, 3);
assert.equal(s.accumulated, 5);
assert.equal(formatPair(s.perHour, s.accumulated), "3/5шт.");

// --- Сброс счётчика после переналадки: 7 -> 1 означает +1 новой детали ---
const withReset = [
  { machine_id: "m2", operation: "Ток 2", counter_value: 7, recorded_at: t("08:00"), kind: "counter" },
  { machine_id: "m2", operation: "Ток 2", counter_value: 1, recorded_at: t("08:30"), kind: "counter" },
];
const l2 = groupEntries(withReset).get("m2|Ток 2");
assert.equal(totalProduced(l2), 8); // 7 + 1 после сброса
s = hourStats(l2, new Date(t("09:00")), new Date(t("10:00")));
assert.equal(s.perHour, 0);   // в 9-м часу замеров нет — выработка уже учтена в 8-м
assert.equal(s.accumulated, 1);

// --- Межчасовой интервал: ничего не теряется и не удваивается ---
// замеры: 09:30 -> 2, 10:40 -> 5. Час 10:00–11:00 даёт +3, а НЕ все 5.
s = hourStats(list, new Date(t("10:00")), new Date(t("11:00")));
assert.equal(s.perHour, 3);

// --- Отчёт: формат как у заказчика ---
const text = renderReport({
  date: t("06:00"),
  shiftCode: "В",
  kindLabel: "день",
  hourLabel: "11:00",
  machines: [
    { sort_order: 0, model: "СК 1680", vais: "ВАИС 003", operators: "Александров А.А. ( ученик )",
      ops: [{ operation: "Ток 1", perHour: 0, accumulated: 0, plan: 24 }], notes: ["нет задела на ток1"] },
    { sort_order: 6, model: "Vturn-46", vais: "ВАИС 003", operators: "Иванов",
      ops: [
        { operation: "Ток 3", perHour: 4, accumulated: 7, plan: 35 },
        { operation: "Доработка", perHour: 1, accumulated: 1, plan: null },
      ], notes: [] },
  ],
  carousel: [{ sort_order: 30, model: "1Л532Ф3 (Фланец 1400)", vais: null, operators: null,
    ops: [{ operation: "Фланец 1400", perHour: 0, accumulated: 0, plan: null }], notes: ["Не в работе"] }],
});
console.log(text);
assert.match(text, /СК Линия: 03\.10\.26 — «день»/);
assert.match(text, /Бригада «В»/);
assert.match(text, /Отчёт на 11:00/);
assert.match(text, /0\. СК 1680 \(ВАИС 003\) - Александров А\.А\. \( ученик \)/);
assert.match(text, /Ток 3 — 4\/7шт\./);
assert.match(text, /План — 35 шт\./);
assert.match(text, /Карусельный:/);
assert.match(text, /Не в работе/);

console.log("\nALL TESTS PASSED");
