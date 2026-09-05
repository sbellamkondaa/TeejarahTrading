<template>
  <div class="inline-flex flex-wrap gap-2">
    <!-- Loading State -->
    <div v-if="loading" class="text-xs text-gray-500 dark:text-gray-400">
      Loading paper positions...
    </div>

    <!-- Paper Positions -->
    <div
      v-for="pos in positions"
      :key="pos.id"
      class="inline-flex items-center px-3 py-1.5 rounded-lg border transition-all"
      :class="Number(pos.realized_pnl) >= 0
        ? 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800'
        : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'"
    >
      <div class="flex items-center space-x-2">
        <span
          class="text-sm font-medium"
          :class="Number(pos.realized_pnl) >= 0
            ? 'text-indigo-800 dark:text-indigo-200'
            : 'text-red-800 dark:text-red-200'"
        >
          {{ pos.symbol }}
        </span>
        <span
          class="text-xs font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          PAPER
        </span>
        <span v-if="pos.realized_pnl !== null && pos.realized_pnl !== undefined" class="text-xs font-medium" :class="Number(pos.realized_pnl) >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'">
          {{ formatSignedCurrency(pos.realized_pnl) }}
        </span>
      </div>
    </div>

    <!-- No positions found -->
    <div v-if="!loading && positions.length === 0" class="text-xs text-gray-500 dark:text-gray-400 italic">
      No paper position details available
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import api from '@/services/api'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'

const props = defineProps({
  positionIds: {
    type: Array,
    required: true
  }
})

const { formatSignedCurrency } = useCurrencyFormatter()

const loading = ref(false)
const positions = ref([])

const fetchPositions = async () => {
  if (!props.positionIds || props.positionIds.length === 0) {
    positions.value = []
    return
  }

  loading.value = true
  try {
    const promises = props.positionIds.map(id =>
      api.get(`/trading/paper-positions/${id}`).catch(err => {
        console.error(`Error fetching paper position ${id}:`, err)
        return null
      })
    )

    const responses = await Promise.all(promises)
    positions.value = responses
      .filter(response => response && response.data && response.data.position)
      .map(response => response.data.position)
  } catch (error) {
    console.error('Error fetching linked paper positions:', error)
    positions.value = []
  } finally {
    loading.value = false
  }
}

watch(() => props.positionIds, () => {
  fetchPositions()
}, { deep: true })

onMounted(() => {
  fetchPositions()
})
</script>
