// Формирование текста отчёта в формате заказчика:
//
//   СК Линия: 03.10.26 — «день»
//   Бригада «В»
//   Отчёт на 11:00
//
//   0. СК 1680 (ВАИС 003) - Александров А.А. ( ученик )
//    Ток 1 — 0/0 шт.
//    План: 24 шт ( нет задела на ток1 )
//   ...
//
import { groupEntries, hourStats, formatPair } from "./core.js";

const pad2 = (n) => String(n).padStart(2, "0");

export function reportTitle(date, shiftCode, kindLabel, hourLabel) {
  const d = `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${String(date.getFullYear()).slice(2)}`;
  return [`СК Линия: ${d} — «${kindLabel}»`, `Бригада «${shiftCode}»`, `Отчёт на ${hourLabel}`].join("\n");
}

/**
 * lines: [{ sort_order, model, vais, operators: "ФИО (ученик)" | null,
 *           ops: [{ operation, perHour, accumulated, plan }], notes: [string] }]
 */
export function buildMachineLine(m, idx) {
  const head = `${idx}. ${m.model}${m.vais ? ` (${m.vais})` : ""}${m.operators ? ` - ${m.operators}` : ""}`;
  const rows = m.ops.map((o) => {
    let line = ` ${o.operation} — ${formatPair(o.perHour, o.accumulated)}`;
    if (o.plan != null) line += `\n План — ${o.plan} шт.`;
    return line;
  });
  const notes = (m.notes ?? []).map((n) => ` ${n}`);
  return [head, ...rows, ...notes].join("\n");
}

export function renderReport({ date, shiftCode, kindLabel, hourLabel, machines, rmu = [], carousel = [] }) {
  const parts = [reportTitle(new Date(date), shiftCode, kindLabel, hourLabel)];
  let i = 0;
  parts.push("");
  parts.push(machines.map((m) => buildMachineLine(m, i++)).join("\n\n"));
  if (rmu.length) {
    parts.push("");
    parts.push("РМУ:");
    parts.push(rmu.map((m) => buildMachineLine(m, "")).join("\n\n").replace(/^\.\s*/gm, ""));
  }
  if (carousel.length) {
    parts.push("");
    parts.push("Карусельный:");
    parts.push(carousel.map((m) => buildMachineLine(m, "")).join("\n\n").replace(/^\.\s*/gm, ""));
  }
  return parts.join("\n");
}

/**
 * Сборка данных отчёта из «сырых» таблиц (приходят из локальной БД телефона).
 * session: { id, starts_at, ends_at }
 * machines/people/assignments/entries — массивы записей.
 * plans: { "machine|operation": qty }
 */
export function assembleReportData({ session, shiftCode, kindLabel, machines, people, assignments, entries, plans, hourEnd }) {
  const groups = groupEntries(entries.filter((e) => e.session_id === session.id));
  const hs = new Date(hourEnd);
  const hStart = new Date(hs.getTime() - 3600_000);

  const operatorByMachine = new Map();
  for (const a of assignments) {
    const p = people.find((x) => x.id === a.person_id);
    if (!p) continue;
    const name = p.full_name + (p.is_apprentice ? " ( ученик )" : "");
    operatorByMachine.set(a.machine_id, operatorByMachine.has(a.machine_id)
      ? `${operatorByMachine.get(a.machine_id)}, ${name}` : name);
  }

  const toLine = (m) => {
    const ops = [];
    const notes = [];
    for (const [key, list] of groups) {
      if (key.split("|")[0] !== m.id) continue;
      const operation = key.split("|")[1];
      const { perHour, accumulated } = hourStats(list, hStart, hs);
      ops.push({ operation, perHour, accumulated, plan: plans[`${m.id}|${operation}`] ?? null });
    }
    for (const e of entries) {
      if (e.session_id === session.id && e.machine_id === m.id && e.kind === "downtime" && e.reason) {
        notes.push(e.reason);
      }
    }
    return { ...m, operators: operatorByMachine.get(m.id) ?? null, ops, notes };
  };

  const sorted = [...machines].sort((a, b) => a.sort_order - b.sort_order);
  return {
    date: session.starts_at,
    shiftCode,
    kindLabel,
    hourLabel: `${pad2(hs.getHours())}:00`,
    machines: sorted.filter((m) => m.grp === "line").map(toLine),
    rmu: sorted.filter((m) => m.grp === "rmu").map(toLine),
    carousel: sorted.filter((m) => m.grp === "carousel").map(toLine),
  };
}
