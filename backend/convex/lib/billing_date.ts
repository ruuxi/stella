export function getWeekBounds(date: Date) {
  const offset = (date.getUTCDay() + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - offset);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);

  return { start, end };
}

export function getMonthlyBounds(now: Date, anchor: Date) {
  const day = anchor.getUTCDate();
  const hh = anchor.getUTCHours();
  const mm = anchor.getUTCMinutes();
  const ss = anchor.getUTCSeconds();
  const ms = anchor.getUTCMilliseconds();

  const anchorAt = (year: number, month: number) => {
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(day, maxDay), hh, mm, ss, ms));
  };

  const shiftMonth = (year: number, month: number, delta: number) => {
    const total = year * 12 + month + delta;
    return [Math.floor(total / 12), ((total % 12) + 12) % 12] as const;
  };

  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let start = anchorAt(year, month);

  if (start > now) {
    [year, month] = shiftMonth(year, month, -1);
    start = anchorAt(year, month);
  }

  const [endYear, endMonth] = shiftMonth(year, month, 1);
  const end = anchorAt(endYear, endMonth);
  return { start, end };
}
