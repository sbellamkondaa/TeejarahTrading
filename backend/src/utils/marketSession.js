/**
 * Server-side U.S. market session detection.
 * Uses America/New_York timezone so session calculation never depends on the
 * server's local timezone. Mirrors the frontend marketStatus.js logic.
 */

const SESSIONS = Object.freeze({
  PREMARKET: 'premarket',
  REGULAR: 'regular',
  AFTER_HOURS: 'after_hours',
  CLOSED: 'closed'
});

/**
 * Get the current U.S. market session based on Eastern Time.
 * @param {Date} now - Optional date override (defaults to current time)
 * @returns {{ session: string, label: string, as_of: number }}
 */
function getMarketSession(now = new Date()) {
  // Format current time in America/New_York without relying on Intl timezone DB
  // by using toLocaleString with timeZone option.
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);

  const day = et.getDay(); // 0 = Sunday, 6 = Saturday
  const hour = et.getHours();
  const minute = et.getMinutes();
  const timeInMinutes = hour * 60 + minute;

  // Weekend
  if (day === 0 || day === 6) {
    return { session: SESSIONS.CLOSED, label: 'Closed (Weekend)', as_of: now.getTime() };
  }

  // Pre-market: 04:00–09:30 ET
  if (timeInMinutes >= 4 * 60 && timeInMinutes < 9 * 60 + 30) {
    return { session: SESSIONS.PREMARKET, label: 'Pre-Market', as_of: now.getTime() };
  }

  // Regular: 09:30–16:00 ET
  if (timeInMinutes >= 9 * 60 + 30 && timeInMinutes < 16 * 60) {
    return { session: SESSIONS.REGULAR, label: 'Regular Hours', as_of: now.getTime() };
  }

  // After-hours: 16:00–20:00 ET
  if (timeInMinutes >= 16 * 60 && timeInMinutes < 20 * 60) {
    return { session: SESSIONS.AFTER_HOURS, label: 'After Hours', as_of: now.getTime() };
  }

  // Closed overnight
  return { session: SESSIONS.CLOSED, label: 'Closed', as_of: now.getTime() };
}

module.exports = { getMarketSession, SESSIONS };
