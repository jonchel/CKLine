// Отправка отчёта стандартными средствами Android: navigator.share -> Share Sheet -> MAX.
// Если Web Share API недоступен (десктоп/старый браузер) — копируем в буфер обмена.

export async function shareReport(text) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "Отчёт", text });
      return "shared"; // мастер выбрал MAX и группу — система сама откроет мессенджер
    } catch (e) {
      if (e.name === "AbortError") return "cancelled"; // мастер отменил — не ошибка
      throw e;
    }
  }
  await navigator.clipboard.writeText(text);
  return "copied";
}

/**
 * Планировщик отчётов: срабатывает за leadMinutes до конца часа.
 * onDue(hourEndDate) — показать напоминание и подготовить текст.
 */
export function scheduleHourlyReports(leadMinutes, onDue) {
  let lastFiredHour = -1;
  const tick = () => {
    const now = new Date();
    const minutesToHourEnd = 60 - now.getMinutes();
    const hourEnd = new Date(now);
    hourEnd.setMinutes(60, 0, 0);
    if (minutesToHourEnd <= leadMinutes && lastFiredHour !== hourEnd.getTime()) {
      lastFiredHour = hourEnd.getTime();
      onDue(hourEnd);
    }
  };
  tick();
  const id = setInterval(tick, 30_000);
  return () => clearInterval(id);
}
