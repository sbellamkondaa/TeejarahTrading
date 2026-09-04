<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="max-w-3xl">
        <p class="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-medium">
          Market intelligence
        </p>
        <h1 class="heading-page mt-1">Premarket & Movers</h1>
        <p class="mt-2 text-gray-600 dark:text-gray-400">
          Stocks moving in the current session. Sourced from Schwab market data.
        </p>
      </div>
      <!-- Session badge -->
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium"
          :class="sessionBadgeClass"
        >
          <span class="h-2 w-2 rounded-full" :class="sessionDotClass"></span>
          {{ sessionLabel }}
        </span>
        <span v-if="asOfLabel" class="text-xs text-gray-500 dark:text-gray-400">
          Updated {{ asOfLabel }}
        </span>
        <span v-if="stale" class="text-xs text-amber-600 dark:text-amber-400">(stale)</span>
      </div>
    </div>

    <!-- Index strip -->
    <div v-if="indices && indices.length" class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
      <div v-for="idx in indices" :key="idx.symbol" class="card px-4 py-3">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-gray-900 dark:text-white">{{ idx.symbol }}</span>
          <span v-if="idx.available && idx.change_percent != null"
            class="text-xs font-medium px-1.5 py-0.5 rounded"
            :class="idx.change_percent >= 0 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'"
          >
            {{ formatPercent(idx.change_percent) }}
          </span>
        </div>
        <div v-if="idx.available" class="mt-1.5">
          <span class="text-lg font-semibold text-mono-num text-gray-900 dark:text-white">
            {{ formatPrice(idx.price) }}
          </span>
          <span class="ml-1.5 text-xs text-mono-num"
            :class="idx.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
          >
            {{ idx.change >= 0 ? '+' : '' }}{{ formatPrice(idx.change) }}
          </span>
        </div>
        <div v-else class="mt-1.5 text-sm text-gray-400 dark:text-gray-500">Unavailable</div>
      </div>
    </div>

    <!-- Category tabs + filters -->
    <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
      <div class="flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
        <button
          v-for="cat in categories"
          :key="cat.value"
          @click="filters.category = cat.value; applyFilters()"
          class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors"
          :class="filters.category === cat.value
            ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'"
        >
          {{ cat.label }}
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model.number="filters.min_price"
          @change="applyFilters"
          type="number"
          placeholder="Min $"
          class="filter-input w-20"
        />
        <input
          v-model.number="filters.max_price"
          @change="applyFilters"
          type="number"
          placeholder="Max $"
          class="filter-input w-20"
        />
        <input
          v-model.number="filters.min_volume"
          @change="applyFilters"
          type="number"
          placeholder="Min Vol"
          class="filter-input w-24"
        />
        <label class="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
          <input type="checkbox" v-model="filters.include_halted" @change="applyFilters" class="rounded" />
          Include halted
        </label>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="state-card text-error">
      Unable to load market movers. {{ error }}
    </div>

    <!-- Empty -->
    <div v-else-if="!movers.length" class="state-card">
      No movers match the current filters.
    </div>

    <!-- Movers table -->
    <div v-else class="mt-4 card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 uppercase text-xs">
            <tr>
              <th class="th">Symbol</th>
              <th class="th">Company</th>
              <th class="th text-right">Price</th>
              <th class="th text-right">Gap %</th>
              <th class="th text-right">Change</th>
              <th class="th text-right">Change %</th>
              <th class="th text-right">Volume</th>
              <th class="th">Catalyst</th>
              <th class="th">Halt</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
            <tr
              v-for="m in movers"
              :key="m.symbol"
              class="hover:bg-gray-50 dark:hover:bg-gray-800/40"
            >
              <td class="td font-semibold text-gray-900 dark:text-white">
                {{ m.symbol }}
              </td>
              <td class="td max-w-[16rem] truncate" :title="m.company_name || ''">
                {{ m.company_name || '—' }}
              </td>
              <td class="td text-right text-mono-num">
                {{ m.last_price != null ? formatPrice(m.last_price) : '—' }}
              </td>
              <td class="td text-right text-mono-num" :class="gapClass(m.gap_pct)">
                {{ m.gap_pct != null ? formatPercent(m.gap_pct) : '—' }}
              </td>
              <td class="td text-right text-mono-num" :class="changeClass(m.change)">
                {{ m.change != null ? (m.change >= 0 ? '+' : '') + formatPrice(m.change) : '—' }}
              </td>
              <td class="td text-right text-mono-num" :class="changeClass(m.change)">
                {{ m.change_percent != null ? formatPercent(m.change_percent) : '—' }}
              </td>
              <td class="td text-right text-mono-num text-gray-500 dark:text-gray-400">
                {{ m.volume != null ? formatVolume(m.volume) : '—' }}
              </td>
              <td class="td">
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="c in (m.catalysts || [])"
                    :key="c.type + (c.timestamp || '')"
                    class="inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium"
                    :class="catalystClass(c.type)"
                    :title="c.label + (c.timestamp ? ' — ' + formatDateTime(c.timestamp) : '')"
                  >
                    {{ c.label }}
                  </span>
                </div>
              </td>
              <td class="td">
                <span v-if="m.halted"
                  class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                >
                  Halted
                </span>
                <span v-else class="text-gray-400 dark:text-gray-500">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Data availability notes -->
    <div class="mt-3 text-xs text-gray-500 dark:text-gray-500 space-y-0.5">
      <p v-if="movers.length">
        Premarket volume and RVOL are not available from the current Schwab movers endpoint.
        Volume shown is current session volume. Source: {{ source }}.
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import api from '@/services/api'

const movers = ref([])
const loading = ref(false)
const error = ref(null)
const sessionLabel = ref('')
const sessionBadgeClass = ref('')
const sessionDotClass = ref('')
const asOfLabel = ref('')
const stale = ref(false)
const source = ref('')
const indices = ref(null)

let pollTimer = null

const categories = [
  { value: 'active', label: 'Most Active' },
  { value: 'gainers', label: 'Gainers' },
  { value: 'losers', label: 'Losers' }
]

const filters = reactive({
  category: 'active',
  min_price: null,
  max_price: null,
  min_volume: null,
  include_halted: true
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

let debounceTimer = null
function applyFilters() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => fetchMovers(), 200)
}

async function fetchMovers() {
  loading.value = true
  error.value = null
  try {
    const params = { category: filters.category, limit: 100 }
    if (filters.min_price != null) params.min_price = filters.min_price
    if (filters.max_price != null) params.max_price = filters.max_price
    if (filters.min_volume != null) params.min_volume = filters.min_volume
    params.include_halted = String(filters.include_halted)
    const { data } = await api.get('/market/movers', { params })
    movers.value = data.movers || []
    sessionLabel.value = data.session_label || data.session || ''
    applySessionClasses(data.session)
    source.value = data.source || ''
    stale.value = Boolean(data.stale)
    indices.value = data.indices || null
    asOfLabel.value = data.as_of ? formatTime(data.as_of) : ''
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || 'Request failed'
    movers.value = []
  } finally {
    loading.value = false
  }
}

function formatPrice(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const sign = Number(value) >= 0 ? '+' : ''
  return sign + Number(value).toFixed(2) + '%'
}

function formatVolume(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toLocaleString()
}

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function changeClass(value) {
  if (value == null) return 'text-gray-400 dark:text-gray-500'
  return value >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
}

function gapClass(value) {
  if (value == null) return 'text-gray-400 dark:text-gray-500'
  return value >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
}

function catalystClass(type) {
  switch (type) {
    case 'earnings': return 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
    case 'sec_filing': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'halt': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'halt_resumed': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
  }
}

onMounted(() => {
  fetchMovers()
  // Bounded polling: refresh movers every 30s (data is Redis-cached 60s on backend)
  pollTimer = setInterval(() => { fetchMovers() }, 30000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
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
  @apply bg-white dark:bg-gray-800 shadow rounded-lg px-4 py-6 text-center text-sm text-gray-600 dark:text-gray-400 mt-4;
}
.text-error {
  @apply text-red-600 dark:text-red-400;
}
.filter-input {
  @apply rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100;
}
</style>
