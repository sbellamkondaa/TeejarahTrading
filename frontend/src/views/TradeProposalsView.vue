<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="max-w-3xl">
      <p class="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-medium">
        Trading automation
      </p>
      <h1 class="heading-page mt-1">Trade Proposals</h1>
      <p class="mt-2 text-gray-600 dark:text-gray-400">
        Versioned trade proposals with lifecycle tracking. Live execution is disabled — all proposals are advisory only.
      </p>
    </div>

    <!-- Filters -->
    <div class="mt-5 flex flex-wrap items-center gap-3">
      <div>
        <label class="text-sm text-gray-600 dark:text-gray-400 mr-2" for="filter-status">Status</label>
        <select id="filter-status" v-model="filters.status" @change="fetchProposals" class="input w-44">
          <option value="">All</option>
          <option v-for="s in lifecycleStates" :key="s" :value="s">{{ formatLabel(s) }}</option>
        </select>
      </div>
      <div>
        <label class="text-sm text-gray-600 dark:text-gray-400 mr-2" for="filter-symbol">Symbol</label>
        <input
          id="filter-symbol"
          v-model="filters.symbol"
          @keydown.enter="fetchProposals"
          type="text"
          placeholder="e.g. AAPL"
          class="input w-32"
          maxlength="20"
        />
      </div>
      <button
        @click="fetchProposals"
        :disabled="loading"
        class="btn-primary"
      >
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="state-card text-error mt-6">
      {{ error }}
    </div>

    <!-- Empty -->
    <div v-else-if="!proposals.length" class="state-card mt-6">
      No trade proposals found. Proposals are created by strategy signals.
    </div>

    <!-- Proposals table -->
    <div v-else class="mt-5 card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left border-b border-gray-200 dark:border-gray-700">
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Symbol</th>
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Dir</th>
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400 text-right">Entry</th>
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400 text-right">Stop</th>
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400 text-right">T1</th>
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400 text-right">R:R</th>
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">State</th>
              <th class="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Created</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in proposals"
              :key="p.id"
              class="border-b border-gray-100 dark:border-gray-800 last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
              @click="openDetail(p.id)"
            >
              <td class="px-4 py-2 font-semibold text-gray-900 dark:text-white">{{ p.symbol }}</td>
              <td class="px-4 py-2">
                <span
                  class="inline-flex px-1.5 py-0.5 rounded text-xs font-medium"
                  :class="p.direction === 'long' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'"
                >{{ p.direction }}</span>
              </td>
              <td class="px-4 py-2 text-right text-mono-num text-gray-700 dark:text-gray-300">
                {{ formatPrice(getEntryLow(p.entry_zone)) }}–{{ formatPrice(getEntryHigh(p.entry_zone)) }}
              </td>
              <td class="px-4 py-2 text-right text-mono-num text-gray-700 dark:text-gray-300">
                {{ formatPrice(p.stop_price) }}
              </td>
              <td class="px-4 py-2 text-right text-mono-num text-gray-700 dark:text-gray-300">
                {{ formatPrice(p.t1_price) }}
              </td>
              <td class="px-4 py-2 text-right text-mono-num text-gray-700 dark:text-gray-300">
                {{ p.rr_ratio != null ? p.rr_ratio.toFixed(1) : '—' }}
              </td>
              <td class="px-4 py-2">
                <span
                  class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                  :class="stateClass(p.lifecycle_state)"
                >{{ formatLabel(p.lifecycle_state) }}</span>
              </td>
              <td class="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                {{ formatDate(p.created_at) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Detail modal -->
    <div v-if="selectedProposal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" @click.self="closeDetail">
      <div class="card max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6">
        <div class="flex items-start justify-between mb-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-xl font-semibold text-gray-900 dark:text-white">{{ selectedProposal.symbol }}</span>
              <span
                class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                :class="stateClass(selectedProposal.lifecycle_state)"
              >{{ formatLabel(selectedProposal.lifecycle_state) }}</span>
            </div>
            <div class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ selectedProposal.direction }} · R:R {{ selectedProposal.rr_ratio || '—' }}
            </div>
          </div>
          <button @click="closeDetail" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
        </div>

        <!-- Proposal details -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div class="text-gray-400 text-xs">Entry Zone</div>
            <div class="text-mono-num text-gray-700 dark:text-gray-300">
              {{ formatPrice(getEntryLow(selectedProposal.entry_zone)) }}–{{ formatPrice(getEntryHigh(selectedProposal.entry_zone)) }}
            </div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">Stop</div>
            <div class="text-mono-num text-gray-700 dark:text-gray-300">{{ formatPrice(selectedProposal.stop_price) }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">T1</div>
            <div class="text-mono-num text-gray-700 dark:text-gray-300">{{ formatPrice(selectedProposal.t1_price) }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">T2</div>
            <div class="text-mono-num text-gray-700 dark:text-gray-300">{{ formatPrice(selectedProposal.t2_price) }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">Position Size</div>
            <div class="text-mono-num text-gray-700 dark:text-gray-300">{{ selectedProposal.position_size || '—' }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">Risk $</div>
            <div class="text-mono-num text-gray-700 dark:text-gray-300">{{ formatPrice(selectedProposal.risk_amount) }}</div>
          </div>
          <div>
            <div class="text-gray-400 text-xs">Runner Target</div>
            <div class="text-mono-num text-gray-700 dark:text-gray-300">{{ formatPrice(selectedProposal.runner_target) }}</div>
          </div>
        </div>

        <!-- Warnings -->
        <div v-if="selectedProposal.warnings && selectedProposal.warnings.length" class="mt-4">
          <div class="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">Warnings</div>
          <ul class="text-sm text-amber-700 dark:text-amber-300 list-disc list-inside">
            <li v-for="(w, i) in selectedProposal.warnings" :key="i">{{ typeof w === 'string' ? w : JSON.stringify(w) }}</li>
          </ul>
        </div>

        <!-- Approvals -->
        <div v-if="selectedProposal.approvals && selectedProposal.approvals.length" class="mt-4">
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Approvals</div>
          <div v-for="a in selectedProposal.approvals" :key="a.id" class="text-sm py-1 flex items-center gap-2">
            <span
              class="inline-flex px-1.5 py-0.5 rounded text-xs font-medium"
              :class="approvalClass(a.decision)"
            >{{ a.decision }}</span>
            <span class="text-gray-500 dark:text-gray-400">{{ formatDate(a.decided_at) }}</span>
            <span v-if="a.note" class="text-gray-600 dark:text-gray-400">— {{ a.note }}</span>
          </div>
        </div>

        <!-- Audit events -->
        <div v-if="selectedProposal.audit_events && selectedProposal.audit_events.length" class="mt-4">
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Audit Trail</div>
          <div class="space-y-1">
            <div v-for="e in selectedProposal.audit_events" :key="e.id" class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <span class="font-mono">{{ formatDate(e.created_at) }}</span>
              <span class="font-medium text-gray-600 dark:text-gray-300">{{ formatLabel(e.event_type) }}</span>
            </div>
          </div>
        </div>

        <!-- Edit form -->
        <div v-if="canEdit && editing" class="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Edit Proposal</div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label class="text-xs text-gray-400">Stop</label>
              <input v-model.number="editForm.stop_price" type="number" step="0.01" class="input w-full" />
            </div>
            <div>
              <label class="text-xs text-gray-400">T1</label>
              <input v-model.number="editForm.t1_price" type="number" step="0.01" class="input w-full" />
            </div>
            <div>
              <label class="text-xs text-gray-400">T2</label>
              <input v-model.number="editForm.t2_price" type="number" step="0.01" class="input w-full" />
            </div>
            <div>
              <label class="text-xs text-gray-400">Runner</label>
              <input v-model.number="editForm.runner_target" type="number" step="0.01" class="input w-full" />
            </div>
            <div>
              <label class="text-xs text-gray-400">Position Size</label>
              <input v-model.number="editForm.position_size" type="number" class="input w-full" />
            </div>
            <div>
              <label class="text-xs text-gray-400">Risk $</label>
              <input v-model.number="editForm.risk_amount" type="number" step="0.01" class="input w-full" />
            </div>
          </div>
          <div class="mt-3 flex gap-2">
            <button @click="saveEdit" :disabled="actionLoading" class="btn-primary">Save</button>
            <button @click="editing = false" class="btn-secondary">Cancel</button>
          </div>
        </div>

        <!-- Action buttons -->
        <div v-if="canAct && !editing" class="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4 flex gap-2">
          <button
            @click="submitDecision('approved')"
            :disabled="actionLoading"
            class="px-4 py-2 rounded-lg text-sm font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >Approve</button>
          <button
            @click="submitDecision('rejected')"
            :disabled="actionLoading"
            class="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >Reject</button>
          <button
            @click="submitDecision('watch')"
            :disabled="actionLoading"
            class="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
          >Watch</button>
          <button
            @click="startEdit"
            :disabled="actionLoading"
            class="px-4 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
          >Edit</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import api from '@/services/api'

const proposals = ref([])
const loading = ref(false)
const error = ref(null)
const selectedProposal = ref(null)
const actionLoading = ref(false)
const editing = ref(false)
const editForm = reactive({})

const filters = reactive({
  status: '',
  symbol: ''
})

const canAct = computed(() => {
  const p = selectedProposal.value
  if (!p) return false
  return ['READY_FOR_APPROVAL', 'WATCH'].includes(p.lifecycle_state)
})

const canEdit = computed(() => canAct.value)

const lifecycleStates = [
  'READY_FOR_APPROVAL',
  'APPROVED',
  'REJECTED',
  'WATCH',
  'ENTRY_SUBMITTED',
  'ENTRY_FILLED',
  'POSITION_ACTIVE',
  'T1_FILLED',
  'T2_FILLED',
  'STOP_FILLED',
  'POSITION_CLOSED',
  'ERROR'
]

onMounted(() => {
  fetchProposals()
})

async function fetchProposals() {
  loading.value = true
  error.value = null
  try {
    const params = {}
    if (filters.status) params.status = filters.status
    if (filters.symbol) params.symbol = filters.symbol.toUpperCase()
    const { data } = await api.get('/trading/proposals', { params })
    proposals.value = data.proposals || []
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || 'Request failed'
    proposals.value = []
  } finally {
    loading.value = false
  }
}

async function openDetail(id) {
  try {
    const { data } = await api.get(`/trading/proposals/${id}`)
    selectedProposal.value = data
  } catch (err) {
    error.value = err?.response?.data?.error || 'Failed to load proposal'
  }
}

function closeDetail() {
  selectedProposal.value = null
  editing.value = false
}

async function submitDecision(decision) {
  actionLoading.value = true
  try {
    await api.post(`/trading/proposals/${selectedProposal.value.id}/approval`, { decision })
    await openDetail(selectedProposal.value.id)
    await fetchProposals()
  } catch (err) {
    error.value = err?.response?.data?.error || 'Failed to submit decision'
  } finally {
    actionLoading.value = false
  }
}

function startEdit() {
  const p = selectedProposal.value
  editForm.stop_price = p.stop_price
  editForm.t1_price = p.t1_price
  editForm.t2_price = p.t2_price
  editForm.runner_target = p.runner_target
  editForm.position_size = p.position_size
  editForm.risk_amount = p.risk_amount
  editing.value = true
}

async function saveEdit() {
  actionLoading.value = true
  try {
    await api.patch(`/trading/proposals/${selectedProposal.value.id}`, editForm)
    editing.value = false
    await openDetail(selectedProposal.value.id)
    await fetchProposals()
  } catch (err) {
    error.value = err?.response?.data?.error || 'Failed to save edit'
  } finally {
    actionLoading.value = false
  }
}

function getEntryLow(zone) {
  if (!zone) return null
  return zone.low ?? zone.min ?? zone.entry ?? null
}

function getEntryHigh(zone) {
  if (!zone) return null
  return zone.high ?? zone.max ?? zone.entry ?? null
}

function formatPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDate(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatLabel(s) {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

function stateClass(state) {
  switch (state) {
    case 'READY_FOR_APPROVAL': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'APPROVED': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'REJECTED': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    case 'WATCH': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'POSITION_ACTIVE': return 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
    case 'STOP_FILLED':
    case 'POSITION_CLOSED': return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
    case 'ERROR':
    case 'MANUAL_INTERVENTION_REQUIRED': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    default: return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  }
}

function approvalClass(decision) {
  switch (decision) {
    case 'approved': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'rejected': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    case 'watch': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    default: return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  }
}
</script>