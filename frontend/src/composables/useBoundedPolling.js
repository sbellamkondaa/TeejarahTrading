/**
 * useBoundedPolling — shared composable for bounded auto-refresh polling.
 *
 * Fetches data on mount and then re-fetches at a configurable interval.
 * Stops polling when the tab is hidden or the component is unmounted.
 * Resumes when the tab becomes visible again.
 *
 * Usage:
 *   const { loading, error, data, lastUpdated, stale, refresh } = useBoundedPolling(
 *     '/market/movers',
 *     { params: {...}, intervalMs: 15000, staleMs: 60000 }
 *   )
 */

import { ref, onMounted, onUnmounted, watch } from 'vue'
import api from '@/services/api'

export function useBoundedPolling(url, options = {}) {
  const {
    params = {},
    intervalMs = 15000,
    staleMs = 60000,
    immediate = true,
    transform = null
  } = options

  const loading = ref(false)
  const error = ref(null)
  const data = ref(null)
  const lastUpdated = ref(null)
  const isPolling = ref(false)

  let timer = null
  let lastParams = { ...params }

  const stale = ref(false)

  async function fetch() {
    if (loading.value) return
    loading.value = true
    error.value = null
    try {
      const { data: response } = await api.get(url, { params: lastParams })
      const result = transform ? transform(response) : response
      data.value = result
      lastUpdated.value = Date.now()
      updateStale()
    } catch (err) {
      error.value = err?.response?.data?.error || err?.message || 'Request failed'
    } finally {
      loading.value = false
    }
  }

  function updateStale() {
    if (!lastUpdated.value) {
      stale.value = true
      return
    }
    stale.value = (Date.now() - lastUpdated.value) > staleMs
  }

  function startPolling() {
    if (timer) return
    isPolling.value = true
    timer = setInterval(() => {
      updateStale()
      fetch()
    }, intervalMs)
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    isPolling.value = false
  }

  function setParams(newParams) {
    lastParams = { ...params, ...newParams }
    fetch()
  }

  function refresh() {
    return fetch()
  }

  function onVisibilityChange() {
    if (document.hidden) {
      stopPolling()
    } else {
      // Tab became visible — immediately refresh and resume polling
      fetch()
      startPolling()
    }
  }

  onMounted(() => {
    if (immediate) fetch()
    startPolling()
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onUnmounted(() => {
    stopPolling()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return {
    loading,
    error,
    data,
    lastUpdated,
    stale,
    isPolling,
    refresh,
    setParams
  }
}
