<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="max-w-3xl">
      <p class="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-medium">
        Market intelligence
      </p>
      <h1 class="heading-page mt-1">Relationship Graph</h1>
      <p class="mt-2 text-gray-600 dark:text-gray-400">
        Industry peers and 30-day price correlation for a symbol. Peers from Finnhub, correlation from Schwab daily candles.
      </p>
    </div>

    <!-- Symbol search -->
    <div class="mt-5 flex items-center gap-3">
      <div class="flex items-center gap-2">
        <label class="text-sm text-gray-600 dark:text-gray-400" for="rel-symbol">Symbol</label>
        <input
          id="rel-symbol"
          v-model="symbolInput"
          @keydown.enter="fetchGraph"
          type="text"
          placeholder="e.g. AAPL"
          class="input w-32"
          maxlength="20"
        />
      </div>
      <button
        @click="fetchGraph"
        :disabled="loading || !symbolInput.trim()"
        class="btn-primary"
      >
        {{ loading ? 'Loading…' : 'Load' }}
      </button>
      <span v-if="fetchedAtLabel" class="text-xs text-gray-500 dark:text-gray-400">
        {{ fetchedAtLabel }}
      </span>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="state-card text-error mt-6">
      {{ error }}
    </div>

    <!-- Graph -->
    <div v-else-if="graph" class="mt-6 space-y-6">
      <!-- Main symbol card -->
      <div class="card px-5 py-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex items-baseline gap-2 flex-wrap">
              <span class="text-2xl font-semibold text-gray-900 dark:text-white">{{ graph.symbol }}</span>
              <span v-if="graph.name" class="text-gray-600 dark:text-gray-400">{{ graph.name }}</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-3 text-sm text-gray-500 dark:text-gray-400">
              <span v-if="graph.industry">
                <span class="text-gray-400">Industry:</span>
                <span class="ml-1 font-medium text-gray-700 dark:text-gray-300">{{ graph.industry }}</span>
              </span>
              <span v-if="graph.country">
                <span class="text-gray-400">Country:</span>
                <span class="ml-1 font-medium text-gray-700 dark:text-gray-300">{{ graph.country }}</span>
              </span>
              <span v-if="graph.exchange">
                <span class="text-gray-400">Exchange:</span>
                <span class="ml-1 font-medium text-gray-700 dark:text-gray-300">{{ graph.exchange }}</span>
              </span>
              <span v-if="graph.market_cap != null">
                <span class="text-gray-400">Market Cap:</span>
                <span class="ml-1 font-medium text-mono-num text-gray-700 dark:text-gray-300">{{ formatMarketCap(graph.market_cap) }}</span>
              </span>
            </div>
          </div>
          <div v-if="graph.last_price != null" class="text-right">
            <div class="text-2xl font-semibold text-mono-num text-gray-900 dark:text-white">
              {{ formatPrice(graph.last_price) }}
            </div>
            <div
              class="mt-0.5 text-sm text-mono-num"
              :class="changeClass(graph.change_percent)"
            >
              {{ graph.change >= 0 ? '+' : '' }}{{ formatPrice(graph.change) }}
              ({{ formatPercent(graph.change_percent) }})
            </div>
          </div>
        </div>
      </div>

      <!-- Peers -->
      <div>
        <div class="flex items-center justify-between mb-3">
          <h2 class="heading-section">Industry Peers</h2>
          <span class="text-xs text-gray-500 dark:text-gray-400">{{ graph.peers.length }} peer{{ graph.peers.length === 1 ? '' : 's' }}</span>
        </div>

        <div v-if="!graph.peers.length" class="state-card">
          No peer symbols returned for {{ graph.symbol }}.
        </div>
        <div v-else class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left border-b border-gray-200 dark:border-gray-700">
                  <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Symbol</th>
                  <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400 text-right">Price</th>
                  <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400 text-right">Change %</th>
                  <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400 text-right">Correlation</th>
                  <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Strength</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in graph.peers"
                  :key="p.symbol"
                  class="border-b border-gray-100 dark:border-gray-800 last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  @click="loadSymbol(p.symbol)"
                >
                  <td class="px-4 py-2 font-semibold text-gray-900 dark:text-white">{{ p.symbol }}</td>
                  <td class="px-4 py-2 text-right text-mono-num text-gray-700 dark:text-gray-300">
                    {{ formatPrice(p.last_price) }}
                  </td>
                  <td class="px-4 py-2 text-right text-mono-num" :class="changeClass(p.change_percent)">
                    {{ formatPercent(p.change_percent) }}
                  </td>
                  <td class="px-4 py-2 text-right text-mono-num text-gray-700 dark:text-gray-300">
                    {{ p.correlation != null ? p.correlation.toFixed(2) : '—' }}
                  </td>
                  <td class="px-4 py-2">
                    <span
                      v-if="p.correlation_strength !== 'insufficient_data'"
                      class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                      :class="correlationClass(p.correlation)"
                    >
                      {{ correlationLabel(p.correlation_strength) }}
                    </span>
                    <span v-else class="text-xs text-gray-400 dark:text-gray-500">Insufficient data</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty (no search yet) -->
    <div v-else class="state-card mt-6">
      Enter a symbol above to view its industry peers and price correlation.
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/services/api'

const route = useRoute()

const symbolInput = ref('')
const graph = ref(null)
const loading = ref(false)
const error = ref(null)
const fetchedAtLabel = ref('')

onMounted(() => {
  const q = route.query.symbol
  if (q && typeof q === 'string') {
    symbolInput.value = q.toUpperCase()
    fetchGraph()
  } else {
    symbolInput.value = 'AAPL'
    fetchGraph()
  }
})

async function fetchGraph() {
  const sym = symbolInput.value.trim().toUpperCase()
  if (!sym) return
  loading.value = true
  error.value = null
  graph.value = null
  try {
    const { data } = await api.get(`/market/relationships/${encodeURIComponent(sym)}`)
    graph.value = data
    fetchedAtLabel.value = data.fetched_at
      ? 'As of ' + new Date(data.fetched_at).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : ''
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || 'Unable to load relationship data'
  } finally {
    loading.value = false
  }
}

function loadSymbol(symbol) {
  symbolInput.value = symbol
  fetchGraph()
}

function formatPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPercent(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(2) + '%'
}

function formatMarketCap(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T'
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M'
  return '$' + v.toFixed(0)
}

function changeClass(pct) {
  if (pct == null) return ''
  if (pct > 0) return 'text-green-600 dark:text-green-400'
  if (pct < 0) return 'text-red-600 dark:text-red-400'
  return ''
}

function correlationClass(r) {
  if (r == null) return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  const abs = Math.abs(r)
  if (abs >= 0.7) return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  if (abs >= 0.4) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
  if (abs >= 0.2) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
}

function correlationLabel(strength) {
  const labels = {
    strong: 'Strong',
    moderate: 'Moderate',
    weak: 'Weak',
    negligible: 'Negligible',
    insufficient_data: '—'
  }
  return labels[strength] || strength
}
</script>
