<template>
  <div>
    <!-- Loading State -->
    <div v-if="loading" class="flex justify-center py-4">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
    </div>

    <!-- No Paper Positions -->
    <div v-else-if="availablePositions.length === 0" class="text-sm text-gray-500 dark:text-gray-400 italic">
      No closed paper positions found
    </div>

    <!-- Position List -->
    <div v-else class="space-y-2">
      <div
        v-for="pos in availablePositions"
        :key="pos.id"
        class="flex items-center justify-between p-3 border rounded-lg transition-colors"
        :class="isSelected(pos.id)
          ? 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-300 dark:border-indigo-700'
          : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'"
      >
        <div class="flex items-center space-x-3 flex-1">
          <input
            type="checkbox"
            :checked="isSelected(pos.id)"
            @change="togglePosition(pos.id)"
            class="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
          />
          <div class="flex-1">
            <div class="flex items-center space-x-2">
              <span class="text-sm font-medium text-gray-900 dark:text-white">
                {{ pos.symbol }}
              </span>
              <span
                class="px-2 py-0.5 text-xs font-semibold rounded bg-indigo-100 text-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-400"
              >
                PAPER
              </span>
              <span v-if="pos.strategy_name" class="text-xs text-gray-500 dark:text-gray-400">
                {{ pos.strategy_name }}
              </span>
            </div>
            <div class="mt-1 flex items-center space-x-4 text-xs text-gray-500 dark:text-gray-400">
              <span>Qty: {{ pos.total_qty }}</span>
              <span v-if="pos.avg_entry_price">Entry: {{ formatCurrency(pos.avg_entry_price) }}</span>
              <span v-if="pos.realized_pnl !== null" :class="Number(pos.realized_pnl) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
                P/L: {{ formatSignedCurrency(pos.realized_pnl) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Selected Count -->
    <div v-if="selectedPositions.length > 0" class="mt-3 text-sm text-gray-600 dark:text-gray-400">
      {{ selectedPositions.length }} paper position{{ selectedPositions.length !== 1 ? 's' : '' }} selected
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import api from '@/services/api'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'

const props = defineProps({
  modelValue: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits(['update:modelValue'])

const { formatCurrency, formatSignedCurrency } = useCurrencyFormatter()

const loading = ref(false)
const availablePositions = ref([])
const selectedPositions = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const isSelected = (posId) => {
  return selectedPositions.value.includes(posId)
}

const togglePosition = (posId) => {
  const index = selectedPositions.value.indexOf(posId)
  if (index > -1) {
    const newSelection = [...selectedPositions.value]
    newSelection.splice(index, 1)
    selectedPositions.value = newSelection
  } else {
    selectedPositions.value = [...selectedPositions.value, posId]
  }
}

const fetchPositions = async () => {
  loading.value = true
  try {
    const response = await api.get('/trading/paper-positions', {
      params: { status: 'CLOSED', limit: 100 }
    })
    availablePositions.value = response.data.positions || []
  } catch (error) {
    console.error('Error fetching paper positions:', error)
    availablePositions.value = []
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, () => {
  if (props.modelValue.length > 0 && availablePositions.value.length === 0) {
    fetchPositions()
  }
}, { immediate: true })
</script>
