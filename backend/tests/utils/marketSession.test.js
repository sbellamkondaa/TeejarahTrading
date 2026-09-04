const { getMarketSession, SESSIONS } = require('../../src/utils/marketSession');

describe('marketSession', () => {
  // Helper: create a Date that, when formatted in America/New_York, falls at a
  // specific ET day/hour/minute. We construct a UTC date that maps to the right
  // ET time. Since ET is UTC-4 (EDT) or UTC-5 (EST), we use a fixed offset for
  // the test and verify the session logic, not the timezone conversion itself.
  // The utility uses `toLocaleString('en-US', { timeZone: 'America/New_York' })`
  // which handles DST automatically.

  function makeDate(etDay, etHour, etMinute) {
    // Create a date in ET by constructing a date string and parsing it.
    // We use a known month (September = EDT = UTC-4) for consistency.
    // etDay: 0=Sunday, 1=Monday, ..., 6=Saturday
    // We pick dates in Sept 2026 that fall on the right weekday.
    const sept2026Days = {
      0: 6,  // Sun = Sept 6
      1: 7,  // Mon = Sept 7
      2: 1,  // Tue = Sept 1
      3: 2,  // Wed = Sept 2
      4: 3,  // Thu = Sept 3
      5: 4,  // Fri = Sept 4
      6: 5   // Sat = Sept 5
    };
    const date = sept2026Days[etDay];
    // ET is UTC-4 in September. So to get ET hour H, UTC = H+4.
    const utcHour = etHour + 4;
    return new Date(Date.UTC(2026, 8, date, utcHour, etMinute, 0));
  }

  test('PREMARKET: 04:00 ET on a weekday', () => {
    const session = getMarketSession(makeDate(1, 4, 0)); // Monday 4:00 AM ET
    expect(session.session).toBe(SESSIONS.PREMARKET);
    expect(session.label).toBe('Pre-Market');
  });

  test('PREMARKET: 09:29 ET on a weekday', () => {
    const session = getMarketSession(makeDate(2, 9, 29)); // Tuesday 9:29 AM ET
    expect(session.session).toBe(SESSIONS.PREMARKET);
  });

  test('REGULAR: 09:30 ET on a weekday', () => {
    const session = getMarketSession(makeDate(3, 9, 30)); // Wednesday 9:30 AM ET
    expect(session.session).toBe(SESSIONS.REGULAR);
    expect(session.label).toBe('Regular Hours');
  });

  test('REGULAR: 15:59 ET on a weekday', () => {
    const session = getMarketSession(makeDate(4, 15, 59)); // Thursday 3:59 PM ET
    expect(session.session).toBe(SESSIONS.REGULAR);
  });

  test('AFTER_HOURS: 16:00 ET on a weekday', () => {
    const session = getMarketSession(makeDate(5, 16, 0)); // Friday 4:00 PM ET
    expect(session.session).toBe(SESSIONS.AFTER_HOURS);
    expect(session.label).toBe('After Hours');
  });

  test('AFTER_HOURS: 19:59 ET on a weekday', () => {
    const session = getMarketSession(makeDate(1, 19, 59)); // Monday 7:59 PM ET
    expect(session.session).toBe(SESSIONS.AFTER_HOURS);
  });

  test('CLOSED: 20:00 ET on a weekday', () => {
    const session = getMarketSession(makeDate(2, 20, 0)); // Tuesday 8:00 PM ET
    expect(session.session).toBe(SESSIONS.CLOSED);
  });

  test('CLOSED: 03:59 ET on a weekday (before premarket)', () => {
    const session = getMarketSession(makeDate(3, 3, 59)); // Wednesday 3:59 AM ET
    expect(session.session).toBe(SESSIONS.CLOSED);
  });

  test('CLOSED: Saturday', () => {
    const session = getMarketSession(makeDate(6, 10, 0)); // Saturday 10:00 AM ET
    expect(session.session).toBe(SESSIONS.CLOSED);
    expect(session.label).toContain('Weekend');
  });

  test('CLOSED: Sunday', () => {
    const session = getMarketSession(makeDate(0, 12, 0)); // Sunday noon ET
    expect(session.session).toBe(SESSIONS.CLOSED);
    expect(session.label).toContain('Weekend');
  });

  test('as_of is set to a timestamp', () => {
    const session = getMarketSession();
    expect(session.as_of).toBeGreaterThan(0);
  });

  test('SESSIONS is frozen', () => {
    expect(Object.isFrozen(SESSIONS)).toBe(true);
  });
});
