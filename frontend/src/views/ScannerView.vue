<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="max-w-3xl">
        <p class="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-medium">
          Market intelligence
        </p>
        <h1 class="heading-page mt-1">Scanner</h1>
        <p class="mt-2 text-gray-600 dark:text-gray-400">
          Deterministic setup screening. No AI. Scores are rule-based.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium"
          :class="sessionBadgeClass">
          <span class="h-2 w-2 rounded-full" :class="sessionDotClass"></span>
          {{ sessionLabel }}
        </span>
        <span v-if="asOfLabel" class="text-xs text-gray-500 dark:text-gray-400">
          Updated {{ asOfLabel }}
        </span>
      </div>
    </div>

    <!-- Filters -->
    <div class="mt-5 flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2">
        <label class="text-sm text-gray-600 dark:text-gray-400">Min Score</label>
        <input v-model.number="filters.min_score" @change="applyFilters" type="number" min="0" max="100"
          class="filter-input w-20" />
      </div>
      <label class="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
        <input type="checkbox" v-model="filters.exclude_penny" @change="applyFilters" class="rounded" />
        Exclude penny stocks
      </label>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="state-card text-error">
      {{ error }}
    </div>

    <!-- Empty -->
    <div v-else-if="!candidates.length" class="state-card">
      No candidates match the current scan criteria.
    </div>

    <!-- Candidates -->
    <div v-else class="mt-4 space-y-3">
      <div v-for="c in candidates" :key="c.symbol"
        class="card px-4 py-3 hover:shadow-md transition-shadow">
        <!-- Row header (click to expand) -->
        <div class="flex items-start justify-between gap-3 cursor-pointer" @click="toggleExpand(c.symbol)">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-semibold text-gray-900 dark:text-white">{{ c.symbol }}</span>
              <span v-if="c.classification" class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold"
                :class="classificationClass(c.classification)"
                :title="classificationReason(c)"
              >{{ c.classification }}</span>
              <span v-if="c.halted"
                class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
              >Halted</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">{{ c.company_name || '—' }}</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-1">
              <span v-for="s in c.setups" :key="s.setup_type"
                class="inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium"
                :class="setupScoreClass(s.score)"
                :title="s.reason"
              >
                {{ setupLabel(s.setup_type) }} {{ s.score }}
              </span>
            </div>
            <div v-if="c.catalyst_evidence?.length" class="mt-1 flex flex-wrap gap-1">
              <span v-for="cat in c.catalyst_evidence" :key="cat.event_type + (cat.event_time || '')"
                class="inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium"
                :class="catalystClass(cat.event_type)"
                :title="'Strength: ' + cat.strength"
              >{{ cat.label }}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-lg font-semibold text-mono-num text-gray-900 dark:text-white">
              {{ formatPrice(c.last_price) }}
            </div>
            <div class="text-sm text-mono-num" :class="(c.change_percent ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
              {{ c.change_percent >= 0 ? '+' : '' }}{{ formatPercent(c.change_percent) }}
            </div>
            <div v-if="c.gap_pct != null" class="text-xs text-mono-num text-gray-500 dark:text-gray-400">
              Gap {{ c.gap_pct >= 0 ? '+' : '' }}{{ formatPercent(c.gap_pct) }}
            </div>
            <div class="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
              {{ expanded.has(c.symbol) ? '▲ less' : '▼ more' }}
            </div>
          </div>
        </div>

        <!-- Expanded details -->
        <div v-if="expanded.has(c.symbol)" class="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 space-y-3">
          <!-- Why classified -->
          <div v-if="c.avoid_reason || c.avoid_chasing_reason || c.best_setup" class="text-xs">
            <p class="text-gray-500 dark:text-gray-400 font-medium">Why {{ c.classification }}:</p>
            <p v-if="c.avoid_reason" class="text-red-600 dark:text-red-400 mt-0.5">{{ c.avoid_reason }}</p>
            <p v-else-if="c.avoid_chasing_reason" class="text-amber-600 dark:text-amber-400 mt-0.5">{{ c.avoid_chasing_reason }}</p>
            <p v-if="c.best_setup" class="text-gray-600 dark:text-gray-300 mt-0.5">{{ c.best_setup.reason }}</p>
            <p v-if="c.dilution_reasons?.length" class="text-gray-500 dark:text-gray-400 mt-0.5">
              Dilution risk {{ c.dilution_risk_level }}: {{ c.dilution_reasons.join('; ') }}
            </p>
          </div>

          <!-- Catalyst evidence -->
          <div v-if="c.catalyst_evidence?.length" class="text-xs">
            <p class="text-gray-500 dark:text-gray-400 font-medium">
              Catalyst evidence
              <span v-if="c.catalyst_strength != null" class="ml-1 text-gray-400">(strength {{ c.catalyst_strength }}/100)</span>
            </p>
            <ul class="mt-1 space-y-0.5">
              <li v-for="(cat, i) in c.catalyst_evidence" :key="i" class="flex items-center gap-2">
                <span :class="catalystClass(cat.event_type)" class="inline-flex px-1.5 py-0.5 rounded font-medium">{{ cat.label }}</span>
                <span class="text-gray-500 dark:text-gray-400">{{ formatDate(cat.event_time) }}</span>
                <a v-if="cat.source_url" :href="cat.source_url" target="_blank" rel="noopener noreferrer"
                  class="text-primary-600 dark:text-primary-400 hover:underline">source</a>
              </li>
            </ul>
          </div>

          <!-- Dilution risk evidence -->
          <div v-if="c.dilution_risk?.evidence?.length" class="text-xs">
            <p class="text-gray-500 dark:text-gray-400 font-medium">Dilution evidence ({{ c.dilution_risk.level }})</p>
            <ul class="mt-1 space-y-0.5">
              <li v-for="(ev, i) in c.dilution_risk.evidence" :key="i" class="text-gray-600 dark:text-gray-300">
                <a v-if="ev.url" :href="ev.url" target="_blank" rel="noopener noreferrer"
                  class="text-primary-600 dark:text-primary-400 hover:underline">{{ ev.form_type || ev.type }}</a>
                <span v-else>{{ ev.form_type || ev.type }}</span>
                <span v-if="ev.filing_date" class="text-gray-400 ml-1">{{ ev.filing_date }}</span>
                <span class="text-gray-400 ml-1">{{ ev.note }}</span>
              </li>
            </ul>
          </div>

          <!-- Fundamentals -->
          <div v-if="c.fundamental_summary" class="text-xs">
            <p class="text-gray-500 dark:text-gray-400 font-medium">Fundamentals</p>
            <div class="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
              <div v-if="c.fundamental_summary.revenue_growth != null">
                <span class="text-gray-400">Rev growth:</span>
                <span class="text-mono-num">{{ c.fundamental_summary.revenue_growth.toFixed(1) }}%</span>
              </div>
              <div v-if="c.fundamental_summary.eps_ttm != null">
                <span class="text-gray-400">EPS (TTM):</span>
                <span class="text-mono-num">{{ c.fundamental_summary.eps_ttm.toFixed(2) }}</span>
              </div>
              <div v-if="c.fundamental_summary.gross_margin != null">
                <span class="text-gray-400">Gross margin:</span>
                <span class="text-mono-num">{{ c.fundamental_summary.gross_margin.toFixed(1) }}%</span>
              </div>
              <div v-if="c.fundamental_summary.net_margin != null">
                <span class="text-gray-400">Net margin:</span>
                <span class="text-mono-num">{{ c.fundamental_summary.net_margin.toFixed(1) }}%</span>
              </div>
              <div v-if="c.fundamental_summary.cash_per_share != null">
                <span class="text-gray-400">Cash/sh:</span>
                <span class="text-mono-num">${{ c.fundamental_summary.cash_per_share.toFixed(2) }}</span>
              </div>
              <div v-if="c.fundamental_summary.debt_to_equity != null">
                <span class="text-gray-400">D/E:</span>
                <span class="text-mono-num">{{ c.fundamental_summary.debt_to_equity.toFixed(2) }}</span>
              </div>
              <div v-if="c.fundamental_summary.market_cap != null">
                <span class="text-gray-400">Mkt cap:</span>
                <span class="text-mono-num">{{ formatMarketCap(c.fundamental_summary.market_cap) }}</span>
              </div>
              <div v-if="c.fundamental_summary.cash_runway_months != null">
                <span class="text-gray-400">Runway:</span>
                <span class="text-mono-num">{{ c.fundamental_summary.cash_runway_months.toFixed(1) }}mo</span>
              </div>
            </div>
            <p v-if="c.fundamental_summary.unavailable?.length" class="text-gray-400 dark:text-gray-500 mt-1">
              Unavailable: {{ c.fundamental_summary.unavailable.join(', ') }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import api from '@/services/api'

const candidates = ref([])
const loading = ref(false)
const error = ref(null)
const sessionLabel = ref('')
const sessionBadgeClass = ref('')
const sessionDotClass = ref('')
const asOfLabel = ref('')
const expanded = reactive(new Set())

const filters = reactive({
  min_score: 40,
  exclude_penny: true
})

const sessionClassMap = {
  premarket: { badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', dot: 'bg-blue-500' },
  regular: { badge: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', dot: 'bg-green-500' },
  after_hours: { badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300', dot: 'bg-purple-500' },
  closed: { badge: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300', dot: 'bg-gray-400' }
}

function applySessionClasses(session) {
  const cls = sessionClassMap[session] || sessionClassMap.closed
  sessionBadgeClass.value = cls.badge
  sessionDotClass.value = cls.dot
}

function applyFilters() {
  fetchScanner()
}

async function fetchScanner() {
  loading.value = true
  error.value = null
  try {
    const params = { limit: 100, min_score: filters.min_score, exclude_penny: String(filters.exclude_penny) }
    const { data } = await api.get('/market/scanner', { params })
    candidates.value = data.candidates || []
    sessionLabel.value = data.session_label || data.session || ''
    applySessionClasses(data.session)
    asOfLabel.value = data.as_of ? new Date(data.as_of).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || 'Request failed'
    candidates.value = []
  } finally {
    loading.value = false
  }
}

function formatPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPercent(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(2) + '%'
}

function setupLabel(type) {
  const labels = {
    gap_and_catalyst: 'Gap+Catalyst',
    momentum: 'Momentum',
    rvol_surge: 'RVOL Surge',
    vwap_reclaim: 'VWAP Reclaim',
    vwap_loss: 'VWAP Loss',
    opening_range_breakout: 'OR Breakout',
    opening_range_breakdown: 'OR Breakdown',
    breakout: 'Breakout',
    relative_strength: 'Rel Strength',
    earnings_reaction: 'Earnings React',
    sec_catalyst: 'SEC Catalyst',
    halt_resumption: 'Halt Resume',
    unusual_volume: 'Unusual Vol'
  }
  return labels[type] || type
}

function setupScoreClass(score) {
  if (score >= 70) return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  if (score >= 50) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
  if (score >= 40) return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
  return 'bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
}

function catalystClass(type) {
  switch (type) {
    case 'earnings': return 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
    case 'sec_material_filing': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'offering_financing': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    case 'insider_form_4': return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
    case 'halt': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'halt_resumption': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    // legacy catalyst types (from movers page)
    case 'sec_filing': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'halt_resumed': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
  }
}

function toggleExpand(symbol) {
  if (expanded.has(symbol)) {
    expanded.delete(symbol)
  } else {
    expanded.add(symbol)
  }
}

function classificationClass(cls) {
  switch (cls) {
    case 'TRADE': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'WATCH': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'AVOID_CHASING': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'AVOID': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
  }
}

function classificationReason(c) {
  if (c.avoid_reason) return c.avoid_reason
  if (c.avoid_chasing_reason) return c.avoid_chasing_reason
  if (c.classification === 'TRADE') return 'High deterministic setup score with acceptable risk profile'
  if (c.classification === 'WATCH') return 'Setup qualifies but score below TRADE threshold'
  return ''
}

function formatDate(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatMarketCap(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(1) + 'T'
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M'
  return '$' + v.toFixed(0)
}

let pollTimer = null

onMounted(() => {
  fetchScanner()
  pollTimer = setInterval(() => { fetchScanner() }, 30000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.state-card {
  @apply bg-white dark:bg-gray-800 shadow rounded-lg px-4 py-6 text-center text-sm text-gray-600 dark:text-gray-400 mt-4;
}
.text-error { @apply text-red-600 dark:text-red-400; }
.filter-input {
  @apply rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100;
}
</style>
