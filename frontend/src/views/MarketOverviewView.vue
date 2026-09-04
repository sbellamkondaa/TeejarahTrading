<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="max-w-3xl">
      <p class="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-medium">
        Market intelligence
      </p>
      <h1 class="heading-page mt-1">Market Overview</h1>
      <p class="mt-2 text-gray-600 dark:text-gray-400">
        Live index quotes, trading halts, market news, upcoming earnings, and recent SEC activity.
        Data is read-only and sourced from existing Teejarah pipelines.
      </p>
    </div>

    <!-- Indices -->
    <section class="mt-8">
      <h2 class="heading-section mb-3">Market Indices</h2>
      <div v-if="indicesState.loading" class="flex justify-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
      <div v-else-if="indicesState.error" class="state-card text-error">
        Index quotes are temporarily unavailable. {{ indicesState.error }}
      </div>
      <div v-else-if="indicesState.data && indicesState.data.length">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div
            v-for="idx in indicesState.data"
            :key="idx.symbol"
            class="card px-4 py-3"
          >
            <div class="flex items-center justify-between">
              <span class="font-semibold text-gray-900 dark:text-white">{{ idx.symbol }}</span>
              <span
                v-if="idx.available && idx.change_percent != null"
                class="text-xs font-medium px-1.5 py-0.5 rounded"
                :class="idx.change_percent >= 0 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'"
              >
                {{ formatPercent(idx.change_percent) }}
              </span>
            </div>
            <div v-if="idx.available" class="mt-1.5">
              <div class="text-xl font-semibold text-mono-num text-gray-900 dark:text-white">
                {{ formatPrice(idx.price) }}
              </div>
              <div
                class="mt-0.5 text-xs text-mono-num"
                :class="idx.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
              >
                {{ idx.change >= 0 ? '+' : '' }}{{ formatPrice(idx.change) }}
              </div>
              <div class="mt-1 text-[11px] text-gray-500 dark:text-gray-500">
                {{ freshnessLabel(idx.timestamp) }}
              </div>
            </div>
            <div v-else class="mt-1.5 text-sm text-gray-400 dark:text-gray-500">
              Unavailable
            </div>
          </div>
        </div>
      </div>
      <div v-else class="state-card">No index data available.</div>
    </section>

    <!-- Trading Halts -->
    <section class="mt-8">
      <div class="flex items-center justify-between mb-3">
        <h2 class="heading-section">Trading Halts</h2>
        <router-link
          v-if="haltsState.data && haltsState.data.length"
          to="/market/halts"
          class="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
        >
          View all
        </router-link>
      </div>
      <div v-if="haltsState.loading" class="flex justify-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
      <div v-else-if="haltsState.error" class="state-card text-error">
        Unable to load trading halts. {{ haltsState.error }}
      </div>
      <div v-else-if="haltsState.data && haltsState.data.length">
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="min-w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 uppercase text-xs">
                <tr>
                  <th class="th">Symbol</th>
                  <th class="th">Market</th>
                  <th class="th">Reason</th>
                  <th class="th">Halt Time</th>
                  <th class="th">Resume Time</th>
                  <th class="th">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                <tr
                  v-for="halt in haltsState.data"
                  :key="halt.symbol + halt.halted_at + halt.halt_type"
                  class="hover:bg-gray-50 dark:hover:bg-gray-800/40"
                >
                  <td class="td font-semibold text-gray-900 dark:text-white">{{ halt.symbol }}</td>
                  <td class="td">{{ halt.exchange || '—' }}</td>
                  <td class="td text-mono-num">{{ halt.halt_type || '—' }}</td>
                  <td class="td text-mono-num">{{ formatDateTime(halt.halted_at) }}</td>
                  <td class="td text-mono-num">{{ halt.resume_at ? formatDateTime(halt.resume_at) : '—' }}</td>
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
      <div v-else class="state-card">No trading halts on record.</div>
    </section>

    <!-- Market News -->
    <section class="mt-8">
      <h2 class="heading-section mb-3">Market News</h2>
      <div v-if="newsState.loading" class="flex justify-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
      <div v-else-if="newsState.error" class="state-card text-error">
        Unable to load market news. {{ newsState.error }}
      </div>
      <div v-else-if="newsState.data && newsState.data.length">
        <ul class="card divide-y divide-gray-100 dark:divide-gray-800">
          <li
            v-for="item in newsState.data"
            :key="item.id"
            class="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/40"
          >
            <a
              :href="item.url"
              target="_blank"
              rel="noopener noreferrer"
              class="block"
            >
              <div class="flex items-start justify-between gap-3">
                <p class="font-medium text-gray-900 dark:text-white leading-snug">
                  {{ item.headline }}
                </p>
                <span
                  v-if="item.related"
                  class="shrink-0 text-xs font-semibold text-primary-600 dark:text-primary-400"
                >
                  {{ item.related }}
                </span>
              </div>
              <div class="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span v-if="item.source">{{ item.source }}</span>
                <span v-if="item.source && item.datetime">·</span>
                <span v-if="item.datetime">{{ relativeTime(item.datetime) }}</span>
              </div>
            </a>
          </li>
        </ul>
      </div>
      <div v-else class="state-card">No market news available.</div>
    </section>

    <!-- Upcoming Earnings -->
    <section class="mt-8">
      <h2 class="heading-section mb-3">Upcoming Earnings</h2>
      <div v-if="earningsState.loading" class="flex justify-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
      <div v-else-if="earningsState.error" class="state-card text-error">
        Unable to load earnings. {{ earningsState.error }}
      </div>
      <div v-else-if="earningsState.data && earningsState.data.length">
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="min-w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 uppercase text-xs">
                <tr>
                  <th class="th">Symbol</th>
                  <th class="th">Date</th>
                  <th class="th">When</th>
                  <th class="th">Quarter</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                <tr
                  v-for="e in earningsState.data"
                  :key="e.symbol + e.date"
                  class="hover:bg-gray-50 dark:hover:bg-gray-800/40"
                >
                  <td class="td font-semibold text-gray-900 dark:text-white">{{ e.symbol }}</td>
                  <td class="td text-mono-num">{{ e.date }}</td>
                  <td class="td">{{ earningsWhenLabel(e.hour) }}</td>
                  <td class="td text-mono-num">{{ e.quarter != null ? 'Q' + e.quarter : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p
          v-if="earningsState.fetched_at"
          class="mt-1.5 text-[11px] text-gray-500 dark:text-gray-500"
        >
          Earnings cache as of {{ formatDateTime(earningsState.fetched_at) }}
        </p>
      </div>
      <div v-else class="state-card">No upcoming earnings in the cache window.</div>
    </section>

    <!-- Recent SEC Activity -->
    <section class="mt-8">
      <h2 class="heading-section mb-3">Recent SEC Activity</h2>
      <div v-if="filingsState.loading" class="flex justify-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
      <div v-else-if="filingsState.error" class="state-card text-error">
        Unable to load SEC filings. {{ filingsState.error }}
      </div>
      <div v-else-if="filingsState.data && filingsState.data.length">
        <ul class="card divide-y divide-gray-100 dark:divide-gray-800">
          <li
            v-for="(f, i) in filingsState.data"
            :key="(f.ticker || 'unk') + (f.form_type || '') + (f.accepted_at || f.filing_date || '') + i"
            class="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/40"
          >
            <a
              :href="f.url"
              target="_blank"
              rel="noopener noreferrer"
              class="block"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <span class="font-semibold text-gray-900 dark:text-white">{{ f.ticker || '—' }}</span>
                  <span
                    v-if="f.form_type"
                    class="ml-2 text-xs font-medium px-1.5 py-0.5 rounded bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300"
                  >
                    {{ f.form_type }}
                  </span>
                </div>
                <span class="shrink-0 text-xs text-mono-num text-gray-500 dark:text-gray-400">
                  {{ f.filing_date || formatDateTime(f.accepted_at) }}
                </span>
              </div>
              <p
                v-if="f.company_name"
                class="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate"
              >
                {{ f.company_name }}
              </p>
            </a>
          </li>
        </ul>
      </div>
      <div v-else class="state-card">No recent SEC filings on record.</div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import api from '@/services/api'

const indicesState = reactive({ loading: false, error: null, data: null })
const haltsState = reactive({ loading: false, error: null, data: null })
const newsState = reactive({ loading: false, error: null, data: null })
const earningsState = reactive({ loading: false, error: null, data: null, fetched_at: null })
const filingsState = reactive({ loading: false, error: null, data: null })

async function fetchIndices() {
  indicesState.loading = true
  indicesState.error = null
  try {
    const { data } = await api.get('/market/indices')
    indicesState.data = data.indices
  } catch (err) {
    indicesState.error = err?.response?.data?.error || err?.message || 'Request failed'
  } finally {
    indicesState.loading = false
  }
}

async function fetchHalts() {
  haltsState.loading = true
  haltsState.error = null
  try {
    const { data } = await api.get('/market/halts', { params: { limit: 10 } })
    haltsState.data = data.halts
  } catch (err) {
    haltsState.error = err?.response?.data?.error || err?.message || 'Request failed'
  } finally {
    haltsState.loading = false
  }
}

async function fetchNews() {
  newsState.loading = true
  newsState.error = null
  try {
    const { data } = await api.get('/market/news', { params: { limit: 15 } })
    newsState.data = data.news
  } catch (err) {
    newsState.error = err?.response?.data?.error || err?.message || 'Request failed'
  } finally {
    newsState.loading = false
  }
}

async function fetchEarnings() {
  earningsState.loading = true
  earningsState.error = null
  try {
    const { data } = await api.get('/market/earnings', { params: { limit: 10 } })
    earningsState.data = data.earnings
    earningsState.fetched_at = data.fetched_at
  } catch (err) {
    earningsState.error = err?.response?.data?.error || err?.message || 'Request failed'
  } finally {
    earningsState.loading = false
  }
}

async function fetchFilings() {
  filingsState.loading = true
  filingsState.error = null
  try {
    const { data } = await api.get('/market/filings', { params: { limit: 10 } })
    filingsState.data = data.filings
  } catch (err) {
    filingsState.error = err?.response?.data?.error || err?.message || 'Request failed'
  } finally {
    filingsState.loading = false
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

function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}

function relativeTime(unixSeconds) {
  if (!unixSeconds || !Number.isFinite(Number(unixSeconds))) return ''
  const diffMs = Date.now() - Number(unixSeconds) * 1000
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + 'm ago'
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return hrs + 'h ago'
  const days = Math.round(hrs / 24)
  if (days < 7) return days + 'd ago'
  return formatDateTime(Number(unixSeconds) * 1000)
}

function freshnessLabel(unixSeconds) {
  if (!unixSeconds || !Number.isFinite(Number(unixSeconds))) return ''
  return 'Updated ' + relativeTime(unixSeconds)
}

function earningsWhenLabel(hour) {
  if (!hour) return '—'
  const h = String(hour).toLowerCase()
  if (h === 'bmo' || h.includes('before')) return 'Before open'
  if (h === 'amc' || h.includes('after')) return 'After close'
  return hour
}

onMounted(() => {
  fetchIndices()
  fetchHalts()
  fetchNews()
  fetchEarnings()
  fetchFilings()
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
  @apply bg-white dark:bg-gray-800 shadow rounded-lg px-4 py-6 text-center text-sm text-gray-600 dark:text-gray-400;
}
.text-error {
  @apply text-red-600 dark:text-red-400;
}
</style>
