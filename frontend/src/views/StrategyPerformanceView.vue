<template>
  <div class="max-w-6xl mx-auto p-4 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Strategy Backtest</h1>
      <button
        @click="showCreateForm = !showCreateForm"
        class="btn-primary text-sm"
      >
        {{ showCreateForm ? 'Cancel' : 'New Backtest' }}
      </button>
    </div>

    <!-- Create form -->
    <div v-if="showCreateForm" class="card p-6 space-y-4">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Strategy</label>
          <select v-model="createForm.strategyId" class="input w-full">
            <option v-for="s in strategies" :key="s.id" :value="s.id">
              {{ s.name }} v{{ s.version }} ({{ s.status }})
            </option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Symbols (comma-separated)</label>
          <input
            v-model="createForm.symbolsInput"
            type="text"
            placeholder="AAPL, MSFT, NVDA"
            class="input w-full"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date From</label>
          <input v-model="createForm.dateFrom" type="date" class="input w-full" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date To</label>
          <input v-model="createForm.dateTo" type="date" class="input w-full" />
        </div>
      </div>
      <button
        @click="runBacktest"
        :disabled="running || !createForm.strategyId || !createForm.symbolsInput"
        class="btn-primary"
      >
        {{ running ? 'Running…' : 'Run Backtest' }}
      </button>
      <span v-if="runError" class="text-sm text-red-600 dark:text-red-400">{{ runError }}</span>
    </div>

    <!-- Runs list -->
    <div v-if="!selectedRun" class="space-y-3">
      <div v-if="runs.length === 0" class="text-center text-gray-500 dark:text-gray-400 py-12">
        No backtest runs yet. Create one to see strategy performance.
      </div>
      <div
        v-for="run in runs"
        :key="run.id"
        @click="openRun(run)"
        class="card p-4 cursor-pointer hover:ring-2 hover:ring-primary-400 transition"
      >
        <div class="flex items-center justify-between">
          <div>
            <span class="font-semibold text-gray-900 dark:text-white">{{ run.strategy_name }} v{{ run.strategy_version }}</span>
            <span class="ml-2 text-sm text-gray-500 dark:text-gray-400">
              {{ run.date_from }} → {{ run.date_to }}
            </span>
            <span v-if="run.symbols?.length" class="ml-2 text-xs text-gray-400">
              {{ run.symbols.length }} symbols
            </span>
          </div>
          <div class="flex items-center gap-3">
            <span
              class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold"
              :class="statusClass(run.status)"
            >{{ run.status }}</span>
            <span v-if="run.total_trades != null" class="text-sm text-gray-600 dark:text-gray-400">
              {{ run.total_trades }} trades
            </span>
          </div>
        </div>
        <div v-if="run.status === 'completed' && run.metrics" class="mt-2 flex gap-4 text-sm text-gray-600 dark:text-gray-400">
          <span>Win rate <span class="font-semibold text-mono-num">{{ run.metrics.winRate }}%</span></span>
          <span>Expectancy <span class="font-semibold text-mono-num">{{ run.metrics.expectancyR }}R</span></span>
          <span>Cumulative <span class="font-semibold text-mono-num">{{ run.metrics.cumulativeR }}R</span></span>
          <span v-if="!run.metrics.sufficient" class="text-amber-600 dark:text-amber-400">
            Small sample ({{ run.metrics.sampleSize }})
          </span>
        </div>
      </div>
    </div>

    <!-- Run detail -->
    <div v-if="selectedRun" class="space-y-4">
      <button @click="selectedRun = null" class="text-sm text-primary-600 hover:text-primary-700">
        ← Back to list
      </button>

      <div class="card p-6">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-xl font-bold text-gray-900 dark:text-white">
              {{ selectedRun.strategy_name }} v{{ selectedRun.strategy_version }}
            </h2>
            <div class="text-sm text-gray-500 dark:text-gray-400">
              {{ selectedRun.date_from }} → {{ selectedRun.date_to }} ·
              {{ selectedRun.symbols?.join(', ') }}
            </div>
          </div>
          <span
            class="inline-flex px-3 py-1 rounded-full text-sm font-bold"
            :class="selectedRun.metrics?.sufficient ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'"
          >
            Sample: {{ selectedRun.metrics?.sampleSize || 0 }}
          </span>
        </div>

        <!-- Metrics grid -->
        <div v-if="selectedRun.metrics && selectedRun.metrics.totalTrades > 0" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div v-for="m in metricCards" :key="m.label" class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3">
            <div class="text-xs text-gray-400">{{ m.label }}</div>
            <div class="text-lg font-semibold text-mono-num text-gray-900 dark:text-white">{{ m.value }}</div>
          </div>
        </div>

        <div v-else class="text-center text-gray-500 dark:text-gray-400 py-8">
          No trades in this backtest run. The strategy did not trigger any signals in the specified date range.
        </div>

        <div v-if="!selectedRun.metrics?.sufficient && selectedRun.metrics?.totalTrades > 0" class="mt-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-sm">
          Insufficient sample size ({{ selectedRun.metrics?.sampleSize }} trades). Results may not be statistically reliable. Minimum recommended: 10 trades.
        </div>
      </div>

      <!-- Segmentation -->
      <div v-if="selectedRun.segmented_metrics && Object.keys(selectedRun.segmented_metrics).length > 0" class="card p-6">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Segmentation</h3>
        <div class="space-y-4">
          <div v-for="(segments, dim) in selectedRun.segmented_metrics" :key="dim">
            <div class="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">{{ formatDim(dim) }}</div>
            <div class="overflow-x-auto">
              <table class="min-w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th class="py-1 pr-4">Segment</th>
                    <th class="py-1 pr-4 text-right">N</th>
                    <th class="py-1 pr-4 text-right">Win%</th>
                    <th class="py-1 pr-4 text-right">Exp R</th>
                    <th class="py-1 pr-4 text-right">Cum R</th>
                    <th class="py-1 pr-4 text-right">PF</th>
                    <th class="py-1 pr-4 text-right">T1%</th>
                    <th class="py-1 pr-4 text-right">T2%</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(m, seg) in segments"
                    :key="seg"
                    class="border-b border-gray-100 dark:border-gray-800"
                  >
                    <td class="py-1 pr-4 text-gray-700 dark:text-gray-300">{{ seg }}</td>
                    <td class="py-1 pr-4 text-right text-mono-num">{{ m.totalTrades }}</td>
                    <td class="py-1 pr-4 text-right text-mono-num">{{ m.winRate }}%</td>
                    <td class="py-1 pr-4 text-right text-mono-num">{{ m.expectancyR }}</td>
                    <td class="py-1 pr-4 text-right text-mono-num">{{ m.cumulativeR }}</td>
                    <td class="py-1 pr-4 text-right text-mono-num">{{ m.profitFactor == null ? '∞' : m.profitFactor }}</td>
                    <td class="py-1 pr-4 text-right text-mono-num">{{ m.t1HitRate }}%</td>
                    <td class="py-1 pr-4 text-right text-mono-num">{{ m.t2HitRate }}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Trades table -->
      <div v-if="trades.length > 0" class="card p-6">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Simulated Trades ({{ trades.length }})</h3>
        <div class="overflow-x-auto max-h-96 overflow-y-auto">
          <table class="min-w-full text-sm">
            <thead class="sticky top-0 bg-white dark:bg-gray-800">
              <tr class="text-left text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th class="py-1 pr-3">Symbol</th>
                <th class="py-1 pr-3">Date</th>
                <th class="py-1 pr-3 text-right">Entry</th>
                <th class="py-1 pr-3 text-right">Stop</th>
                <th class="py-1 pr-3 text-right">Exit</th>
                <th class="py-1 pr-3">Reason</th>
                <th class="py-1 pr-3 text-right">R</th>
                <th class="py-1 pr-3 text-right">Bars</th>
                <th class="py-1 pr-3">T1</th>
                <th class="py-1 pr-3">T2</th>
                <th class="py-1 pr-3">Gap</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in trades"
                :key="t.id"
                class="border-b border-gray-100 dark:border-gray-800"
              >
                <td class="py-1 pr-3 font-medium text-gray-700 dark:text-gray-300">{{ t.symbol }}</td>
                <td class="py-1 pr-3 text-gray-500">{{ t.entry_date }}</td>
                <td class="py-1 pr-3 text-right text-mono-num">{{ formatPrice(t.entry_price) }}</td>
                <td class="py-1 pr-3 text-right text-mono-num">{{ formatPrice(t.stop_price) }}</td>
                <td class="py-1 pr-3 text-right text-mono-num">{{ formatPrice(t.exit_price) }}</td>
                <td class="py-1 pr-3">{{ t.exit_reason }}</td>
                <td class="py-1 pr-3 text-right text-mono-num" :class="t.r_multiple > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
                  {{ t.r_multiple }}
                </td>
                <td class="py-1 pr-3 text-right text-mono-num">{{ t.hold_bars }}</td>
                <td class="py-1 pr-3">{{ t.t1_hit ? '✓' : '—' }}</td>
                <td class="py-1 pr-3">{{ t.t2_hit ? '✓' : '—' }}</td>
                <td class="py-1 pr-3 text-mono-num">{{ t.gap_pct }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import api from '@/services/api'

const runs = ref([])
const strategies = ref([])
const selectedRun = ref(null)
const trades = ref([])
const showCreateForm = ref(false)
const running = ref(false)
const runError = ref('')
const createForm = ref({
  strategyId: '',
  symbolsInput: '',
  dateFrom: '',
  dateTo: ''
})

const formatPrice = (v) => v != null ? Number(v).toFixed(2) : '—'

const metricCards = computed(() => {
  const m = selectedRun.value?.metrics
  if (!m) return []
  return [
    { label: 'Total Trades', value: m.totalTrades },
    { label: 'Win Rate', value: `${m.winRate}%` },
    { label: 'Wins', value: m.wins },
    { label: 'Losses', value: m.losses },
    { label: 'Breakeven', value: m.breakeven },
    { label: 'Avg Winner R', value: m.avgWinnerR },
    { label: 'Avg Loser R', value: m.avgLoserR },
    { label: 'Expectancy R', value: m.expectancyR },
    { label: 'Profit Factor', value: m.profitFactor == null ? '∞' : m.profitFactor },
    { label: 'Cumulative R', value: m.cumulativeR },
    { label: 'Max Drawdown R', value: m.maxDrawdownR },
    { label: 'Max Consec. Losses', value: m.maxConsecutiveLosses },
    { label: 'T1 Hit Rate', value: `${m.t1HitRate}%` },
    { label: 'T2 Hit Rate', value: `${m.t2HitRate}%` },
    { label: 'Stop Hit Rate', value: `${m.stopHitRate}%` },
    { label: 'Avg Hold (bars)', value: m.avgHoldBars },
    { label: 'Median Hold (bars)', value: m.medianHoldBars },
    { label: 'Avg Hold (sec)', value: m.avgHoldSeconds },
    { label: 'Median Hold (sec)', value: m.medianHoldSeconds }
  ]
})

const statusClass = (status) => ({
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}[status] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300')

const formatDim = (dim) => ({
  gapBucket: 'Gap Bucket',
  rvolBucket: 'RVOL Bucket',
  catalystStrength: 'Catalyst Strength',
  catalystType: 'Catalyst Type',
  marketRegime: 'Market Regime',
  volatilityRegime: 'Volatility Regime',
  liquidityRating: 'Liquidity Rating',
  dilutionRiskLevel: 'Dilution Risk',
  pennyStock: 'Penny Stock',
  strategyVersion: 'Strategy Version'
}[dim] || dim)

async function fetchStrategies() {
  try {
    const { data } = await api.get('/trading/strategies')
    strategies.value = data.strategies || []
  } catch (e) {
    // ignore
  }
}

async function fetchRuns() {
  try {
    const { data } = await api.get('/trading/backtest-runs')
    runs.value = data.runs || []
  } catch (e) {
    // ignore
  }
}

async function openRun(run) {
  selectedRun.value = run
  trades.value = []
  if (run.status === 'completed') {
    try {
      const { data } = await api.get(`/trading/backtest-runs/${run.id}/trades`)
      trades.value = data.trades || []
    } catch (e) {
      // ignore
    }
  }
}

async function runBacktest() {
  running.value = true
  runError.value = ''
  try {
    const symbols = createForm.value.symbolsInput
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0)
    const { data } = await api.post('/trading/backtest-runs', {
      strategyId: createForm.value.strategyId,
      dateFrom: createForm.value.dateFrom,
      dateTo: createForm.value.dateTo,
      symbols
    })
    showCreateForm.value = false
    await fetchRuns()
    await openRun(data)
  } catch (e) {
    runError.value = e.response?.data?.error || e.message
  } finally {
    running.value = false
  }
}

onMounted(() => {
  fetchStrategies()
  fetchRuns()
})
</script>
