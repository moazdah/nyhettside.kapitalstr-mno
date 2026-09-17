export function marketValue(symbol, value) {
  const n = Number(value);
  const digits = ['EURNOK', 'USDNOK'].includes(symbol) ? 4 : 2;
  return new Intl.NumberFormat('nb-NO', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function marketDelta(value) {
  const n = Number(value);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${new Intl.NumberFormat('nb-NO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n))} %`;
}

export function relativeTime(value) {
  if (!value) return '';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'nå';
  if (minutes < 60) return `${minutes} min siden`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'time' : 'timer'} siden`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'dag' : 'dager'} siden`;
}

export function clockTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('nb-NO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo'
  }).format(new Date(value));
}

export function fullDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('nb-NO', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Oslo'
  }).format(new Date(value));
}
