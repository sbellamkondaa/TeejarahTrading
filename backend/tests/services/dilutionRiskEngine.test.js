const { classifyDilutionRisk, SHELF_REGISTRATION_FORMS, OFFERING_PROSPECTUS_FORMS } = require('../../src/services/dilutionRiskEngine');

describe('dilutionRiskEngine', () => {

  describe('classifyDilutionRisk', () => {
    test('no filings returns LOW', () => {
      const result = classifyDilutionRisk([]);
      expect(result.level).toBe('LOW');
      expect(result.reasons[0]).toContain('No dilution');
    });

    test('ordinary 8-K does NOT trigger dilution flag', () => {
      const result = classifyDilutionRisk([
        { form_type: '8-K', filing_date: '2026-09-01', filing_url: 'http://sec/8k' }
      ]);
      expect(result.level).toBe('LOW');
      expect(result.evidence.filter(e => e.type !== 'share_expansion')).toHaveLength(0);
    });

    test('10-K/10-Q do NOT trigger dilution flag', () => {
      const result = classifyDilutionRisk([
        { form_type: '10-K', filing_date: '2026-09-01', filing_url: 'http://sec/10k' },
        { form_type: '10-Q', filing_date: '2026-08-01', filing_url: 'http://sec/10q' }
      ]);
      expect(result.level).toBe('LOW');
    });

    test('shelf registration (S-3) returns MEDIUM', () => {
      const result = classifyDilutionRisk([
        { form_type: 'S-3', filing_date: '2026-08-01', filing_url: 'http://sec/s3' }
      ]);
      expect(result.level).toBe('MEDIUM');
      expect(result.reasons[0]).toContain('shelf registration');
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0].type).toBe('shelf_registration');
      expect(result.evidence[0].url).toBe('http://sec/s3');
    });

    test('recent 424B5 (within 90 days) returns HIGH', () => {
      const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const result = classifyDilutionRisk([
        { form_type: '424B5', filing_date: recent, accepted_at: recent, filing_url: 'http://sec/424b5' }
      ]);
      expect(result.level).toBe('HIGH');
      expect(result.reasons[0]).toContain('offering prospectus');
    });

    test('old 424B5 (over 90 days) returns MEDIUM', () => {
      const old = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const result = classifyDilutionRisk([
        { form_type: '424B5', filing_date: old, accepted_at: old, filing_url: 'http://sec/424b5' }
      ]);
      expect(result.level).toBe('MEDIUM');
    });

    test('shelf + prospectus together returns HIGH', () => {
      const old = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const result = classifyDilutionRisk([
        { form_type: 'S-3', filing_date: old, filing_url: 'http://sec/s3' },
        { form_type: '424B5', filing_date: old, accepted_at: old, filing_url: 'http://sec/424b5' }
      ]);
      expect(result.level).toBe('HIGH');
    });

    test('S-1 counts as shelf registration', () => {
      const result = classifyDilutionRisk([
        { form_type: 'S-1', filing_date: '2026-08-01', filing_url: 'http://sec/s1' }
      ]);
      expect(result.level).toBe('MEDIUM');
    });

    test('share expansion > 20% returns MEDIUM without filings', () => {
      const result = classifyDilutionRisk([], {
        share_trend: { trend: 'expanding', pct_change: 25 }
      });
      expect(result.level).toBe('MEDIUM');
      expect(result.evidence.some(e => e.type === 'share_expansion')).toBe(true);
    });

    test('moderate share expansion stays LOW', () => {
      const result = classifyDilutionRisk([], {
        share_trend: { trend: 'stable', pct_change: 5 }
      });
      expect(result.level).toBe('LOW');
    });

    test('evidence includes filing URLs for traceability', () => {
      const result = classifyDilutionRisk([
        { form_type: 'S-3', filing_date: '2026-08-01', filing_url: 'https://sec.gov/x' }
      ]);
      expect(result.evidence[0].url).toBe('https://sec.gov/x');
      expect(result.evidence[0].form_type).toBe('S-3');
    });

    test('multiple recent offerings aggregate reasons', () => {
      const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const result = classifyDilutionRisk([
        { form_type: '424B5', filing_date: recent, accepted_at: recent, filing_url: 'http://a' },
        { form_type: '424B4', filing_date: recent, accepted_at: recent, filing_url: 'http://b' }
      ]);
      expect(result.level).toBe('HIGH');
      expect(result.reasons[0]).toContain('2 offering prospectus');
    });
  });

  describe('form type sets', () => {
    test('SHELF_REGISTRATION_FORMS contains expected forms', () => {
      expect(SHELF_REGISTRATION_FORMS.has('S-3')).toBe(true);
      expect(SHELF_REGISTRATION_FORMS.has('S-1')).toBe(true);
      expect(SHELF_REGISTRATION_FORMS.has('424B5')).toBe(false);
    });

    test('OFFERING_PROSPECTUS_FORMS contains expected forms', () => {
      expect(OFFERING_PROSPECTUS_FORMS.has('424B5')).toBe(true);
      expect(OFFERING_PROSPECTUS_FORMS.has('424B4')).toBe(true);
      expect(OFFERING_PROSPECTUS_FORMS.has('S-3')).toBe(false);
    });
  });
});
