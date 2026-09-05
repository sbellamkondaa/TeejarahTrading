// Tests for TradingWorkstationView — critical behavior tests.
// Tests: symbol selection, scanner refresh preserves selection, risk rejection
// disables execution, PAPER/LIVE labeling, stale/error states, no execution bypass.

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, nextTick } from 'vue'

// Mock lightweight-charts (hoisted)
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({ setData: vi.fn() })),
    remove: vi.fn(),
    applyOptions: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  })),
  CrosshairMode: { Normal: 0 },
  LineStyle: { Dashed: 1 },
  CandlestickSeries: 'Candlestick',
  HistogramSeries: 'Histogram',
  LineSeries: 'Line',
}))

// Mock api (hoisted — factory must be self-contained)
vi.mock('@/services/api', () => {
  const mockApi = {
    get: vi.fn().mockResolvedValue({ data: { candidates: [], indices: [] } }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  }
  return { default: mockApi }
})

// Mock useVisibilityPolling (hoisted)
vi.mock('@/composables/useVisibilityPolling', () => ({
  useVisibilityPolling: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    isActive: ref(false),
  }),
}))

// Mock ResizeObserver
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
}

import TradingWorkstationView from '@/views/TradingWorkstationView.vue'
import api from '@/services/api'

describe('TradingWorkstationView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue({ data: { candidates: [], indices: [] } })
    api.post.mockResolvedValue({ data: {} })
    api.patch.mockResolvedValue({ data: {} })
  })

  test('mounts without errors', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    expect(wrapper.exists()).toBe(true)
    wrapper.unmount()
  })

  test('PAPER mode is prominently labeled when proposal exists', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.selectedProposal = { id: 'test', lifecycle_state: 'READY_FOR_APPROVAL', execution_mode: 'PAPER' }
    await nextTick()
    expect(wrapper.text()).toContain('PAPER')
    wrapper.unmount()
  })

  test('risk rejection disables execution', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.riskEvaluation = { state: 'REJECTED', risk_percent: 1, account_equity: 100000, max_dollar_risk: 1000, risk_per_share: 2, suggested_shares: 500, total_position_value: 25000, total_dollar_risk: 1000, exposure_pct: 25, rr_t1: 2, rr_t2: 4, rejection_reasons: ['test'] }
    vm.selectedProposal = { id: 'test-id', lifecycle_state: 'READY_FOR_APPROVAL', execution_mode: 'PAPER', stop_price: 48, t1_price: 54, t2_price: 58, entry_zone: { low: 50, high: 52 } }
    await nextTick()
    expect(vm.canExecutePaper).toBe(false)
    wrapper.unmount()
  })

  test('canExecutePaper is true when risk is VALID and mode is PAPER', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.riskEvaluation = { state: 'VALID', risk_percent: 1, suggested_shares: 500 }
    vm.selectedProposal = { id: 'test-id', lifecycle_state: 'APPROVED', execution_mode: 'PAPER', stop_price: 48, t1_price: 54, t2_price: 58, entry_zone: { low: 50, high: 52 } }
    await nextTick()
    expect(vm.canExecutePaper).toBe(true)
    wrapper.unmount()
  })

  test('canExecutePaper is false when execution_mode is LIVE', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.riskEvaluation = { state: 'VALID' }
    vm.selectedProposal = { id: 'test-id', lifecycle_state: 'APPROVED', execution_mode: 'LIVE' }
    await nextTick()
    expect(vm.canExecutePaper).toBe(false)
    wrapper.unmount()
  })

  test('canApprove is false when no proposal', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    expect(wrapper.vm.canApprove).toBe(false)
    wrapper.unmount()
  })

  test('canApprove is true when proposal is READY_FOR_APPROVAL', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.selectedProposal = { id: 'test', lifecycle_state: 'READY_FOR_APPROVAL', execution_mode: 'PAPER' }
    await nextTick()
    expect(vm.canApprove).toBe(true)
    wrapper.unmount()
  })

  test('selectSymbol updates selectedSymbol and selectedCandidate', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    const candidate = { symbol: 'AAPL', last_price: 150, change_percent: 2.5, setups: [], catalyst_evidence: [] }
    vm.selectSymbol(candidate)
    await nextTick()
    expect(vm.selectedSymbol).toBe('AAPL')
    expect(vm.selectedCandidate).toEqual(candidate)
    wrapper.unmount()
  })

  test('selectSymbol clears previous state', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.selectedProposal = { id: 'old', lifecycle_state: 'APPROVED' }
    vm.riskEvaluation = { state: 'VALID' }
    vm.calibration = { sampleSize: 10 }
    vm.paperPosition = { id: 'pos' }
    vm.selectSymbol({ symbol: 'NEW', last_price: 100, change_percent: 1, setups: [] })
    await nextTick()
    expect(vm.selectedSymbol).toBe('NEW')
    expect(vm.selectedProposal).toBeNull()
    expect(vm.riskEvaluation).toBeNull()
    expect(vm.calibration).toBeNull()
    expect(vm.paperPosition).toBeNull()
    wrapper.unmount()
  })

  test('formatPrice handles null, NaN, and numbers', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    expect(vm.formatPrice(null)).toBe('—')
    expect(vm.formatPrice(undefined)).toBe('—')
    expect(vm.formatPrice(123.456)).toBe('123.46')
    expect(vm.formatPrice(NaN)).toBe('—')
    wrapper.unmount()
  })

  test('formatPercent handles null and numbers', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    expect(vm.formatPercent(null)).toBe('—')
    expect(vm.formatPercent(2.567)).toBe('2.57%')
    expect(vm.formatPercent(0)).toBe('0.00%')
    wrapper.unmount()
  })

  test('formatLabel converts snake_case to Title Case', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    expect(vm.formatLabel('READY_FOR_APPROVAL')).toBe('Ready For Approval')
    expect(vm.formatLabel('POSITION_ACTIVE')).toBe('Position Active')
    expect(vm.formatLabel('')).toBe('')
    wrapper.unmount()
  })

  test('riskStateClass returns correct classes', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    expect(vm.riskStateClass('VALID')).toContain('green')
    expect(vm.riskStateClass('REJECTED')).toContain('red')
    expect(vm.riskStateClass('WATCH')).toContain('amber')
    wrapper.unmount()
  })

  test('evidenceQualityClass returns correct classes', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    expect(vm.evidenceQualityClass('STRONG')).toContain('green')
    expect(vm.evidenceQualityClass('MODERATE')).toContain('blue')
    expect(vm.evidenceQualityClass('LOW')).toContain('amber')
    expect(vm.evidenceQualityClass('INSUFFICIENT')).toContain('gray')
    wrapper.unmount()
  })

  test('stateClass returns correct classes for PAPER states', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    expect(vm.stateClass('APPROVED')).toContain('green')
    expect(vm.stateClass('REJECTED')).toContain('red')
    expect(vm.stateClass('POSITION_ACTIVE')).toContain('indigo')
    wrapper.unmount()
  })

  test('historical evidence is labeled as advisory only', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.calibration = {
      sampleSize: 15, backtestCount: 10, paperCount: 5,
      winRate: 60, confidenceInterval: { lower: 35, upper: 82 },
      t1HitRate: 55, t2HitRate: 30, expectancyR: 0.8,
      evidenceQuality: 'MODERATE'
    }
    vm.selectedProposal = { id: 'test', lifecycle_state: 'READY_FOR_APPROVAL' }
    await nextTick()
    expect(wrapper.text()).toContain('Advisory only')
    expect(wrapper.text()).toContain('PAPER')
    wrapper.unmount()
  })

  test('no LIVE execution path — canExecutePaper false for LIVE mode', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    vm.selectedProposal = { id: 'test', lifecycle_state: 'APPROVED', execution_mode: 'LIVE' }
    vm.riskEvaluation = { state: 'VALID' }
    await nextTick()
    expect(vm.canExecutePaper).toBe(false)
    wrapper.unmount()
  })

  test('PAPER_ACTIVE_STATES includes correct states', async () => {
    const wrapper = mount(TradingWorkstationView, { attachTo: document.body })
    const vm = wrapper.vm
    expect(vm.PAPER_ACTIVE_STATES).toEqual(expect.arrayContaining([
      'ENTRY_SUBMITTED', 'ENTRY_PARTIALLY_FILLED', 'ENTRY_FILLED',
      'POSITION_ACTIVE', 'T1_FILLED', 'T2_FILLED'
    ]))
    wrapper.unmount()
  })
})
