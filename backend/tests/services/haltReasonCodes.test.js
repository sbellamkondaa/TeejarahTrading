const { describeHaltReasonCode, HALT_REASON_DESCRIPTIONS } = require('../../src/services/nasdaq/haltReasonCodes');

describe('haltReasonCodes', () => {
  test('maps observed live-feed codes to established meanings', () => {
    expect(describeHaltReasonCode('T1')).toBe('News pending');
    expect(describeHaltReasonCode('T12')).toBe('Trading halted pending additional information');
    expect(describeHaltReasonCode('H11')).toBe('Regulatory halt (self-regulatory organization)');
    expect(describeHaltReasonCode('LUDP')).toBe('Limit up / limit down pause');
    expect(describeHaltReasonCode('M')).toBe('Market-wide circuit breaker halt');
  });

  test('returns null for unknown codes (no guessing)', () => {
    expect(describeHaltReasonCode('ZZZ')).toBeNull();
    expect(describeHaltReasonCode('UNKNOWN')).toBeNull();
  });

  test('returns null for null/empty input', () => {
    expect(describeHaltReasonCode(null)).toBeNull();
    expect(describeHaltReasonCode('')).toBeNull();
    expect(describeHaltReasonCode(undefined)).toBeNull();
  });

  test('is case-insensitive and trims whitespace', () => {
    expect(describeHaltReasonCode('t1')).toBe('News pending');
    expect(describeHaltReasonCode('  LUDP  ')).toBe('Limit up / limit down pause');
  });

  test('mapping is frozen (no accidental mutation)', () => {
    expect(Object.isFrozen(HALT_REASON_DESCRIPTIONS)).toBe(true);
  });
});
