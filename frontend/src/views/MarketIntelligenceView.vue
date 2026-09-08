<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="max-w-3xl">
      <p class="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-medium">
        Market intelligence
      </p>
      <h1 class="heading-page mt-1">News &amp; Events</h1>
      <p class="mt-2 text-gray-600 dark:text-gray-400">
        Persistent, searchable market events across SEC filings, halts, news, and social sources.
        Deterministic classification, materiality ranking, and source verification.
      </p>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-500">
        <template v-if="schedulerEnabled">Scheduler active — events refresh automatically.</template>
        <template v-else>Automatic ingestion off. Historical events remain searchable.</template>
      </p>
    </div>

    <!-- Filters -->
    <div class="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div>
        <label class="label" for="f-preset">Time range</label>
        <select id="f-preset" v-model="filters.preset" @change="resetAndLoad" class="input">
          <option value="1h">Last hour</option>
          <option value="4h">Last 4 hours</option>
          <option value="24h">Last 24 hours</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
        </select>
      </div>
      <div>
        <label class="label" for="f-symbol">Symbol</label>
        <input id="f-symbol" v-model="filters.symbol" @input="resetAndLoad" type="text" placeholder="e.g. AAPL" class="input" />
      </div>
      <div>
        <label class="label" for="f-q">Headline search</label>
        <input id="f-q" v-model="filters.q" @input="resetAndLoad" type="text" placeholder="keyword..." class="input" />
      </div>
      <div>
        <label class="label" for="f-type">Event type</label>
        <select id="f-type" v-model="filters.event_type" @change="resetAndLoad" class="input">
          <option value="">All</option>
          <option v-for="t in eventTypes" :key="t" :value="t">{{ t.replace(/_/g, ' ') }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="f-source">Source</label>
        <select id="f-source" v-model="filters.source" @change="resetAndLoad" class="input">
          <option value="">All</option>
          <option v-for="s in sourceOptions" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="f-tier">Source tier</label>
        <select id="f-tier" v-model="filters.source_tier" @change="resetAndLoad" class="input">
          <option value="">All</option>
          <option v-for="t in sourceTiers" :key="t" :value="t">{{ t.replace(/_/g, ' ') }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="f-mat">Min materiality</label>
        <select id="f-mat" v-model="filters.min_materiality" @change="resetAndLoad" class="input">
          <option value="">Any</option>
          <option v-for="n in [5,6,7,8,9,10]" :key="n" :value="n">{{ n }}+</option>
        </select>
      </div>
      <div class="flex items-end gap-2">
        <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" v-model="filters.catalyst_only" @change="resetAndLoad" class="rounded" />
          Catalysts only
        </label>
      </div>
    </div>

    <!-- Source health -->
    <div v-if="sources.length" class="mt-4 flex flex-wrap gap-2 text-xs">
      <span class="text-gray-500 dark:text-gray-400">Sources:</span>
      <span v-for="s in sources" :key="s.name"
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
        :class="s.enabled
          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'">
        {{ s.name.replace('finnhub_news','Finnhub').replace('sec_filings','SEC').replace('nasdaq_halts','Halts').replace('x_api','X').replace('bluesky','Bluesky').replace(/^rss/,'RSS') }}
        <span v-if="!s.enabled" class="opacity-60">(off)</span>
      </span>
    </div>

    <!-- Loading -->
    <div v-if="loading && !events.length" class="flex justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="state-card text-error">
      Unable to load events. {{ error }}
    </div>

    <!-- Empty -->
    <div v-else-if="!events.length" class="state-card">
      No events match the current filters.
    </div>

    <!-- Events list -->
    <div v-else class="mt-5 space-y-3">
      <div v-for="e in events" :key="e.id"
        class="card p-4 hover:shadow-md transition-shadow cursor-pointer"
        @click="goToSymbol(e)">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">{{ e.event_type.replace(/_/g, ' ') }}</span>
              <span v-if="e.source_tier === 'PRIMARY'" class="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">PRIMARY</span>
              <span v-else-if="e.source_tier === 'SOCIAL_UNVERIFIED'" class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">UNVERIFIED</span>
              <span v-else-if="e.verification_state === 'CORROBORATED'" class="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">CORROBORATED</span>
              <span class="text-gray-500 dark:text-gray-400">{{ e.source }}</span>
              <span v-if="e.symbols && e.symbols.length" class="text-gray-700 dark:text-gray-300 font-medium">{{ e.symbols.join(', ') }}</span>
            </div>
            <h3 class="mt-1.5 text-sm font-medium text-gray-900 dark:text-white line-clamp-2">{{ e.headline || '(no headline)' }}</h3>
            <p v-if="e.summary" class="mt-1 text-xs text-gray-600 dark:text-gray-400 line-clamp-2">{{ e.summary }}</p>
          </div>
          <div class="flex flex-col items-end shrink-0 text-xs text-gray-500 dark:text-gray-400">
            <span :title="'Materiality ' + e.materiality + '/10'" class="font-mono">M{{ e.materiality }}</span>
            <span :title="'Score ' + e.score" class="font-mono">S{{ e.score }}</span>
            <span class="mt-1">{{ formatRelative(e.published_at) }}</span>
          </div>
        </div>
      </div>

      <!-- Load more -->
      <div v-if="nextCursor" class="flex justify-center pt-2">
        <button @click="loadMore" :disabled="loadingMore"
          class="btn-secondary px-4 py-2 text-sm disabled:opacity-50">
          <span v-if="loadingMore">Loading...</span>
          <span v-else>Load more</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/services/api'

const router = useRouter()

const events = ref([])
const nextCursor = ref(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref(null)
const schedulerEnabled = ref(false)
const sources = ref([])

const filters = ref({
  preset: '24h',
  symbol: '',
  q: '',
  event_type: '',
  source: '',
  source_tier: '',
  min_materiality: '',
  catalyst_only: false
})

const eventTypes = [
  'EARNINGS', 'GUIDANCE', 'FDA', 'SEC_MATERIAL', 'OFFERING', 'ATM', 'S3', '424B5',
  'DILUTION', 'MERGER_ACQUISITION', 'CONTRACT', 'PARTNERSHIP', 'ANALYST_UPGRADE',
  'ANALYST_DOWNGRADE', 'PRICE_TARGET', 'INSIDER', 'HALT', 'RESUMPTION',
  'MACRO_FED', 'MACRO_INFLATION', 'MACRO_JOBS', 'GENERAL_NEWS', 'OPINION'
]
const sourceTiers = ['PRIMARY', 'HIGH_QUALITY_SECONDARY', 'AGGREGATOR', 'SOCIAL_UNVERIFIED', 'OPINION']
const sourceOptions = ref([])

function paramsForLoad() {
  const p = {}
  if (filters.value.preset) p.preset = filters.value.preset
  if (filters.value.symbol) p.symbol = filters.value.symbol.toUpperCase()
  if (filters.value.q) p.q = filters.value.q
  if (filters.value.event_type) p.event_type = filters.value.event_type
  if (filters.value.source) p.source = filters.value.source
  if (filters.value.source_tier) p.source_tier = filters.value.source_tier
  if (filters.value.min_materiality) p.min_materiality = filters.value.min_materiality
  if (filters.value.catalyst_only) p.catalyst_only = 'true'
  return p
}

let debounceTimer = null
function resetAndLoad() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    nextCursor.value = null
    loadEvents()
  }, 300)
}

async function loadEvents() {
  loading.value = true
  error.value = null
  try {
    const p = paramsForLoad()
    const { data } = await api.get('/market/events', { params: p })
    events.value = data.events || []
    nextCursor.value = data.next_cursor || null
  } catch (e) {
    error.value = e.message || 'Failed to load events'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const p = { ...paramsForLoad(), cursor: nextCursor.value }
    const { data } = await api.get('/market/events', { params: p })
    events.value = [...events.value, ...(data.events || [])]
    nextCursor.value = data.next_cursor || null
  } catch (e) {
    error.value = e.message || 'Failed to load more'
  } finally {
    loadingMore.value = false
  }
}

async function loadSources() {
  try {
    const { data } = await api.get('/market/sources')
    sources.value = data.sources || []
    schedulerEnabled.value = data.scheduler_enabled || false
    sourceOptions.value = sources.value.map((s) => s.name)
  } catch {
    /* non-fatal */
  }
}

function goToSymbol(e) {
  if (e.symbols && e.symbols.length) {
    router.push({ name: 'trading-workstation', query: { symbol: e.symbols[0] } })
  }
}

function formatRelative(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const diff = Date.now() - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
  return d.toLocaleDateString()
}

onMounted(() => {
  loadSources()
  loadEvents()
})
</script>
