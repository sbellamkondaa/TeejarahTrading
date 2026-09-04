<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="max-w-3xl">
      <p class="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-medium">
        Market intelligence
      </p>
      <h1 class="heading-page mt-1">Trading Halts</h1>
      <p class="mt-2 text-gray-600 dark:text-gray-400">
        Recent Nasdaq trading halts and resumptions. Sourced from the Nasdaq Trader RSS feed.
      </p>
      <p v-if="lastUpdated" class="mt-1 text-xs text-gray-500 dark:text-gray-500">
        Last updated: {{ formatDateTime(lastUpdated) }}
        <span v-if="isStale" class="ml-1 text-amber-600 dark:text-amber-400">(stale)</span>
      </p>
    </div>

    <!-- Filters -->
    <div class="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div>
        <label class="label" for="filter-status">Status</label>
        <select id="filter-status" v-model="filters.status" @change="applyFilters" class="input">
          <option value="">All</option>
          <option value="halted">Halted</option>
          <option value="resumed">Resumed</option>
        </select>
      </div>
      <div>
        <label class="label" for="filter-market">Market</label>
        <select id="filter-market" v-model="filters.market" @change="applyFilters" class="input">
          <option value="">All</option>
          <option v-for="m in marketOptions" :key="m" :value="m.toLowerCase()">{{ m }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="filter-reason">Reason</label>
        <select id="filter-reason" v-model="filters.reason" @change="applyFilters" class="input">
          <option value="">All</option>
          <option v-for="r in reasonOptions" :key="r" :value="r.toLowerCase()">{{ r }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="filter-symbol">Symbol</label>
        <input
          id="filter-symbol"
          v-model="filters.symbol"
          @input="applyFilters"
          type="text"
          placeholder="e.g. AAPL"
          class="input"
        />
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="state-card text-error">
      Unable to load trading halts. {{ error }}
    </div>

    <!-- Empty -->
    <div v-else-if="!halts.length" class="state-card">
      No trading halts match the current filters.
    </div>

    <!-- Table -->
    <div v-else class="mt-5 card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 uppercase text-xs">
            <tr>
              <th class="th">Symbol</th>
              <th class="th">Security</th>
              <th class="th">Market</th>
              <th class="th">Reason</th>
              <th class="th">Description</th>
              <th class="th">Halt Time</th>
              <th class="th">Resume Time</th>
              <th class="th">Duration</th>
              <th class="th">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
            <tr
              v-for="halt in halts"
              :key="halt.symbol + halt.halted_at + halt.halt_type"
              class="hover:bg-gray-50 dark:hover:bg-gray-800/40"
            >
              <td class="td font-semibold text-gray-900 dark:text-white">{{ halt.symbol }}</td>
              <td class="td max-w-[18rem] truncate" :title="halt.issue_name || ''">
                {{ halt.issue_name || '—' }}
              </td>
              <td class="td">{{ halt.exchange || '—' }}</td>
              <td class="td text-mono-num">{{ halt.halt_type || '—' }}</td>
              <td class="td max-w-[22rem]">
                <span :title="halt.reason_description || 'Unknown reason code'">
                  {{ halt.reason_description || '—' }}
                </span>
              </td>
              <td class="td text-mono-num">{{ formatDateTime(halt.halted_at) }}</td>
              <td class="td text-mono-num">{{ halt.resume_at ? formatDateTime(halt.resume_at) : '—' }}</td>
              <td class="td text-mono-num">{{ halt.resume_at ? formatDuration(halt.halted_at, halt.resume_at) : '—' }}</td>
              <td class="td">
                <span
                  class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                  :class="halt.status === 'halted'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                    : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'"
                >
                  {{ halt.status === 'halted' ? 'Halted' : 'Resumed' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/services/api'

const route = useRoute()
const router = useRouter()

const halts = ref([])
const loading = ref(false)
const error = ref(null)
const lastUpdated = ref(null)

const filters = reactive({
  status: '',
  market: '',
  reason: '',
  symbol: ''
})

// Distinct markets/reason codes observed in the loaded set (for filter dropdowns).
const marketOptions = computed(() => {
  const s = new Set()
  for (const h of halts.value) {
    if (h.exchange) s.add(h.exchange.toUpperCase())
  }
  return Array.from(s).sort()
})

const reasonOptions = computed(() => {
  const s = new Set()
  for (const h of halts.value) {
    if (h.halt_type) s.add(h.halt_type.toUpperCase())
  }
  return Array.from(s).sort()
})

// Stale if no update in over 5 minutes.
const isStale = computed(() => {
  if (!lastUpdated.value) return false
  return Date.now() - new Date(lastUpdated.value).getTime() > 5 * 60 * 1000
})

let symbolDebounce = null

function applyFilters() {
  // Debounce symbol input; other filters apply immediately.
  if (symbolDebounce) clearTimeout(symbolDebounce)
  symbolDebounce = setTimeout(() => {
    syncQueryParams()
    fetchHalts()
  }, 250)
}

function syncQueryParams() {
  const query = {}
  if (filters.status) query.status = filters.status
  if (filters.market) query.market = filters.market
  if (filters.reason) query.reason = filters.reason
  if (filters.symbol) query.symbol = filters.symbol.toUpperCase()
  router.replace({ query })
}

function readFiltersFromQuery() {
  filters.status = route.query.status ? String(route.query.status).toLowerCase() : ''
  filters.market = route.query.market ? String(route.query.market).toLowerCase() : ''
  filters.reason = route.query.reason ? String(route.query.reason).toLowerCase() : ''
  filters.symbol = route.query.symbol ? String(route.query.symbol).toUpperCase() : ''
}

async function fetchHalts() {
  loading.value = true
  error.value = null
  try {
    const params = { limit: 100 }
    if (filters.status) params.status = filters.status
    if (filters.market) params.market = filters.market
    if (filters.reason) params.reason = filters.reason
    if (filters.symbol) params.symbol = filters.symbol
    const { data } = await api.get('/market/halts', { params })
    halts.value = data.halts || []
    lastUpdated.value = data.last_updated || null
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || 'Request failed'
    halts.value = []
  } finally {
    loading.value = false
  }
}

function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}

function formatDuration(fromIso, toIso) {
  if (!fromIso || !toIso) return '—'
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// Re-read filters if the route changes externally (back/forward).
watch(() => route.query, () => {
  readFiltersFromQuery()
  fetchHalts()
})

onMounted(() => {
  readFiltersFromQuery()
  fetchHalts()
})
</script>

<style scoped>
.th {
  @apply px-3 py-2 text-left font-medium tracking-wider;
}
.td {
  @apply px-3 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap;
}
.state-card {
  @apply bg-white dark:bg-gray-800 shadow rounded-lg px-4 py-6 text-center text-sm text-gray-600 dark:text-gray-400 mt-5;
}
.text-error {
  @apply text-red-600 dark:text-red-400;
}
.label {
  @apply block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1;
}
.input {
  @apply w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100;
}
</style>
