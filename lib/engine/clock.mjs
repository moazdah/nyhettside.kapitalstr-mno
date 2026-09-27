export function activeHours(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Oslo',hour:'2-digit',hourCycle:'h23'}).format(now)) >= 6;
}
export function slot(now = new Date(), minutes = 5) {
  return new Date(Math.floor(now.getTime() / (minutes * 60000)) * minutes * 60000).toISOString();
}
export function liveHealth({ lastSuccess, enabled = true, now = new Date() }) {
  const open = activeHours(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',hourCycle:'h23'}).format(now));
  const sinceOpening = (hour-6)*60 + now.getUTCMinutes() + now.getUTCSeconds()/60;
  const ageMinutes = lastSuccess ? Math.max(0,(now-new Date(lastSuccess))/60000) : null;
  const activeGap = Math.max(0,Math.min(ageMinutes ?? Infinity,sinceOpening));
  const overdue = Math.max(0,activeGap-5);
  return { status: !enabled ? 'paused' : !open ? 'closed' : activeGap>=15 ? 'error' : activeGap>=10 ? 'warning' : 'ok',
    ageMinutes, delayMinutes: enabled && open ? Math.floor(overdue) : 0, activeGapMinutes: Math.floor(activeGap) };
}
