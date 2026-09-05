<template>
  <div class="trading-workstation h-screen flex flex-col bg-gray-50 dark:bg-gray-900 overflow-hidden">
    <!-- TOP MARKET STRIP -->
    <div class="market-strip shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2">
      <div class="flex items-center gap-1 flex-wrap">
        <div v-for="idx in indexQuotes" :key="idx.symbol"
          class="flex items-center gap-1 px-2 py-0.5 rounded text-sm"
          :class="idx.stale ? 'opacity-50' : ''">
          <span class="font-medium text-gray-700 dark:text-gray-300">{{ idx.symbol }}</span>
          <span class="text-mono-num font-semibold" :class="idx.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
            {{ formatPrice(idx.price) }}
          </span>
          <span class="text-xs text-mono-num" :class="idx.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
            {{ idx.change >= 0 ? '+' : '' }}{{ formatPercent(idx.changePercent) }}
          </span>
        </div>
        <div class="ml-auto flex items-center gap-2 text-xs">
          <!-- Paper account summary -->
          <span v-if="paperAccount" class="flex items-center gap-2 px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
            <span class="text-gray-500 dark:text-gray-400">Equity</span>
            <span class="text-mono-num font-semibold text-gray-700 dark:text-gray-300">{{ formatPrice(paperAccount.equity) }}</span>
            <span class="text-gray-400">·</span>
            <span class="text-gray-500 dark:text-gray-400">BP</span>
            <span class="text-mono-num text-gray-700 dark:text-gray-300">{{ formatPrice(paperAccount.buying_power) }}</span>
          </span>
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium"
            :class="sessionBadgeClass">
            <span class="h-1.5 w-1.5 rounded-full" :class="sessionDotClass"></span>
            {{ sessionLabel }}
          </span>
          <span v-if="scannerStale" class="text-amber-600 dark:text-amber-400">stale</span>
          <!-- STOP NEW PAPER TRADING control -->
          <button v-if="!paperTradingHalted"
            @click="haltPaperTrading"
            class="px-2 py-0.5 rounded text-xs font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60">
            STOP NEW PAPER
          </button>
          <button v-else
            @click="unhaltPaperTrading"
            class="px-2 py-0.5 rounded text-xs font-bold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/60">
            RESUME PAPER
          </button>
        </div>
      </div>
    </div>

    <!-- MAIN WORKSTATION LAYOUT -->
    <div class="workstation-grid flex-1 grid grid-cols-12 gap-0 overflow-hidden">

      <!-- LEFT: LIVE SCANNER -->
      <div class="col-span-3 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden flex flex-col">
        <div class="shrink-0 px-3 py-2 border-b border-gray-100 dark:border-gray-700">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Scanner</span>
            <button @click="fetchScanner" :disabled="scannerLoading"
              class="text-xs text-primary-600 hover:text-primary-700 disabled:opacity-50">
              {{ scannerLoading ? '…' : '↻' }}
            </button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="scannerLoading && scanner.length === 0" class="flex justify-center py-8">
            <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
          </div>
          <div v-else-if="scannerError" class="px-3 py-4 text-xs text-red-600 dark:text-red-400">{{ scannerError }}</div>
          <div v-else-if="scanner.length === 0" class="px-3 py-8 text-center text-xs text-gray-400">No candidates</div>
          <div v-else>
            <div v-for="c in scanner" :key="c.symbol"
              @click="selectSymbol(c)"
              class="scanner-row px-3 py-2 cursor-pointer border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
              :class="selectedSymbol === c.symbol ? 'bg-primary-50 dark:bg-primary-900/20 border-l-2 border-l-primary-600' : ''">
              <div class="flex items-center justify-between">
                <span class="font-semibold text-sm text-gray-900 dark:text-white">{{ c.symbol }}</span>
                <span class="text-xs text-mono-num text-gray-500 dark:text-gray-400">{{ formatPrice(c.last_price) }}</span>
              </div>
              <div class="flex items-center justify-between mt-0.5">
                <div class="flex items-center gap-1">
                  <span class="text-xs text-mono-num" :class="(c.change_percent ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
                    {{ (c.change_percent ?? 0) >= 0 ? '+' : '' }}{{ formatPercent(c.change_percent) }}
                  </span>
                  <span v-if="c.halted" class="text-[10px] px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">HALT</span>
                </div>
                <div class="flex items-center gap-1">
                  <span v-if="c.classification" class="text-[10px] px-1 rounded font-medium"
                    :class="classificationClass(c.classification)">{{ c.classification }}</span>
                </div>
              </div>
              <div v-if="c.setups && c.setups.length" class="flex flex-wrap gap-0.5 mt-1">
                <span v-for="s in c.setups.slice(0, 3)" :key="s.setup_type"
                  class="text-[10px] px-1 rounded font-medium"
                  :class="setupScoreClass(s.score)">
                  {{ setupLabel(s.setup_type) }} {{ s.score }}
                </span>
              </div>
              <div v-if="c.catalyst_evidence && c.catalyst_evidence.length" class="mt-0.5">
                <span v-for="cat in c.catalyst_evidence.slice(0, 2)" :key="cat.event_type + (cat.event_time || '')"
                  class="text-[10px] px-1 rounded font-medium mr-0.5"
                  :class="catalystClass(cat.event_type)">{{ cat.label }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- CENTER: CHART WORKSPACE -->
      <div class="col-span-6 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden flex flex-col">
        <div class="shrink-0 px-4 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span v-if="selectedSymbol" class="text-lg font-bold text-gray-900 dark:text-white">{{ selectedSymbol }}</span>
            <span v-else class="text-sm text-gray-400">Select a symbol from the scanner</span>
            <span v-if="quoteData" class="text-sm text-mono-num font-semibold" :class="quoteData.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
              {{ formatPrice(quoteData.current_price) }}
            </span>
            <span v-if="quoteData" class="text-xs text-mono-num" :class="quoteData.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
              {{ quoteData.change >= 0 ? '+' : '' }}{{ formatPercent(quoteData.change_percent) }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <div class="flex items-center gap-1">
              <button v-for="tf in timeframes" :key="tf.value"
                @click="changeTimeframe(tf.value)"
                :class="timeframe === tf.value ? 'bg-primary-600 text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
                class="px-2 py-0.5 rounded text-xs font-medium">
                {{ tf.label }}
              </button>
            </div>
            <span v-if="chartStale" class="text-xs text-amber-600 dark:text-amber-400">stale</span>
          </div>
        </div>
        <div class="flex-1 relative overflow-hidden">
          <div ref="chartContainer" class="absolute inset-0"></div>
          <div v-if="chartLoading && !chartData" class="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-gray-800/50">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
          <div v-else-if="chartError && !chartData" class="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
            {{ chartError }}
          </div>
          <div v-else-if="!chartData || chartData.length === 0" class="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
            No chart data available
          </div>
        </div>
        <!-- Bottom detail tabs -->
        <div class="shrink-0 border-t border-gray-200 dark:border-gray-700 max-h-48 overflow-hidden flex flex-col">
          <div class="flex shrink-0 border-b border-gray-100 dark:border-gray-700">
            <button v-for="tab in tabs" :key="tab.key"
              @click="activeTab = tab.key"
              :class="activeTab === tab.key ? 'border-b-2 border-primary-600 text-primary-600 dark:text-primary-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
              class="px-3 py-1.5 text-xs font-medium">
              {{ tab.label }}
            </button>
          </div>
          <div class="flex-1 overflow-y-auto px-3 py-2">
            <!-- News tab -->
            <div v-if="activeTab === 'news'" class="space-y-2">
              <div v-if="newsLoading" class="text-xs text-gray-400">Loading…</div>
              <div v-else-if="news.length === 0" class="text-xs text-gray-400">No news</div>
              <div v-for="n in news.slice(0, 10)" :key="n.id || n.url" class="text-xs">
                <a v-if="n.url" :href="n.url" target="_blank" class="text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">{{ n.headline }}</a>
                <span v-else class="text-gray-700 dark:text-gray-300 font-medium">{{ n.headline }}</span>
                <span class="text-gray-400 ml-1">{{ formatDate(n.datetime || n.date) }}</span>
                <p class="text-gray-500 dark:text-gray-400 line-clamp-1">{{ n.summary }}</p>
              </div>
            </div>
            <!-- Catalysts tab -->
            <div v-else-if="activeTab === 'catalysts'" class="space-y-1">
              <div v-if="!selectedCandidate || !selectedCandidate.catalyst_evidence || selectedCandidate.catalyst_evidence.length === 0" class="text-xs text-gray-400">No catalysts</div>
              <div v-for="cat in selectedCandidate?.catalyst_evidence || []" :key="cat.event_type + (cat.event_time || '')" class="text-xs flex items-center gap-2">
                <span class="px-1 rounded font-medium" :class="catalystClass(cat.event_type)">{{ cat.label }}</span>
                <span class="text-gray-500">Strength: {{ cat.strength }}</span>
                <span class="text-gray-400">{{ formatDate(cat.event_time) }}</span>
              </div>
            </div>
            <!-- SEC tab -->
            <div v-else-if="activeTab === 'sec'" class="space-y-1">
              <div v-if="secLoading" class="text-xs text-gray-400">Loading…</div>
              <div v-else-if="secFilings.length === 0" class="text-xs text-gray-400">No recent filings</div>
              <div v-for="f in secFilings.slice(0, 10)" :key="f.id || f.filing_id" class="text-xs">
                <span class="font-medium text-gray-700 dark:text-gray-300">{{ f.form_type }}</span>
                <span class="text-gray-400 ml-1">{{ formatDate(f.filing_date || f.date) }}</span>
                <a v-if="f.url" :href="f.url" target="_blank" class="text-primary-600 ml-1">↗</a>
              </div>
            </div>
            <!-- Fundamentals tab -->
            <div v-else-if="activeTab === 'fundamentals'" class="space-y-1">
              <div v-if="!selectedCandidate" class="text-xs text-gray-400">Select a symbol</div>
              <template v-else-if="selectedCandidate.fundamental_summary">
                <div class="text-xs grid grid-cols-2 gap-1">
                  <span class="text-gray-500">Market Cap:</span><span class="text-mono-num">{{ formatMarketCap(selectedCandidate.fundamental_summary.market_cap) }}</span>
                  <span class="text-gray-500">Revenue Growth:</span><span class="text-mono-num">{{ formatPercent(selectedCandidate.fundamental_summary.revenue_growth) }}</span>
                  <span class="text-gray-500">EPS TTM:</span><span class="text-mono-num">{{ formatPrice(selectedCandidate.fundamental_summary.eps_ttm) }}</span>
                  <span class="text-gray-500">Loss Making:</span><span>{{ selectedCandidate.fundamental_summary.is_loss_making ? 'Yes' : 'No' }}</span>
                </div>
              </template>
              <div v-else class="text-xs text-gray-400">No fundamental data</div>
            </div>
            <!-- Dilution tab -->
            <div v-else-if="activeTab === 'dilution'" class="space-y-1">
              <div v-if="!selectedCandidate" class="text-xs text-gray-400">Select a symbol</div>
              <div v-else-if="selectedCandidate.dilution_risk" class="text-xs">
                <span class="font-medium" :class="dilutionLevelClass(selectedCandidate.dilution_risk.level)">
                  Dilution: {{ selectedCandidate.dilution_risk.level }}
                </span>
                <div v-if="selectedCandidate.dilution_risk.reasons" class="text-gray-500 mt-1">
                  <div v-for="r in selectedCandidate.dilution_risk.reasons" :key="r" class="text-xs">{{ r }}</div>
                </div>
              </div>
              <div v-else class="text-xs text-gray-400">No dilution risk detected</div>
            </div>
            <!-- Execution tab -->
            <div v-else-if="activeTab === 'execution'" class="space-y-1">
              <div v-if="!selectedProposal" class="text-xs text-gray-400">No proposal for this symbol</div>
              <template v-else>
                <div class="text-xs flex items-center gap-2">
                  <span class="font-medium">PAPER</span>
                  <span class="px-1.5 py-0.5 rounded text-xs font-semibold" :class="stateClass(selectedProposal.lifecycle_state)">
                    {{ formatLabel(selectedProposal.lifecycle_state) }}
                  </span>
                </div>
                <div v-if="paperPosition" class="text-xs space-y-0.5">
                  <div>Entry: <span class="text-mono-num">{{ formatPrice(paperPosition.avg_entry_price) }}</span></div>
                  <div>Qty: <span class="text-mono-num">{{ paperPosition.total_qty }}</span> · Remaining: <span class="text-mono-num">{{ paperPosition.remaining_qty }}</span></div>
                  <div>Realized P&L: <span class="text-mono-num" :class="Number(paperPosition.realized_pnl) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ formatPrice(paperPosition.realized_pnl) }}</span></div>
                  <div v-if="unrealizedPnl != null">Unrealized: <span class="text-mono-num" :class="unrealizedPnl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ formatPrice(unrealizedPnl) }}</span></div>
                </div>
                <div v-if="paperOrders && paperOrders.length" class="mt-2">
                  <div v-for="o in paperOrders" :key="o.id" class="text-xs flex items-center gap-1.5 py-0.5">
                    <span class="px-1 rounded text-[10px] font-medium" :class="orderStatusClass(o.status)">{{ o.status }}</span>
                    <span>{{ o.order_type }}</span>
                    <span class="text-mono-num">{{ o.filled_qty }}/{{ o.quantity }}</span>
                    <span v-if="o.avg_fill_price" class="text-gray-400">@ {{ formatPrice(o.avg_fill_price) }}</span>
                  </div>
                </div>
              </template>
            </div>
            <!-- Audit tab -->
            <div v-else-if="activeTab === 'audit'" class="space-y-1">
              <div v-if="!selectedProposal || !selectedProposal.audit_events || selectedProposal.audit_events.length === 0" class="text-xs text-gray-400">No audit events</div>
              <div v-for="e in selectedProposal?.audit_events || []" :key="e.id" class="text-xs flex items-center gap-2">
                <span class="text-gray-400">{{ formatDate(e.created_at) }}</span>
                <span class="font-medium">{{ e.event_type }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: TRADE SETUP PANEL -->
      <div class="col-span-3 bg-white dark:bg-gray-800 overflow-y-auto">
        <div class="p-3 space-y-3">
          <!-- Setup section -->
          <div>
            <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">Trade Setup</div>
            <div v-if="!selectedCandidate" class="text-xs text-gray-400">Select a symbol from the scanner</div>
            <div v-else class="space-y-1 text-xs">
              <div class="flex justify-between"><span class="text-gray-500">Symbol</span><span class="font-medium text-gray-900 dark:text-white">{{ selectedCandidate.symbol }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Price</span><span class="text-mono-num">{{ formatPrice(selectedCandidate.last_price) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Gap %</span><span class="text-mono-num" :class="(selectedCandidate.gap_pct ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ formatPercent(selectedCandidate.gap_pct) }}</span></div>
              <div v-if="selectedCandidate.rvol != null" class="flex justify-between"><span class="text-gray-500">RVOL</span><span class="text-mono-num">{{ selectedCandidate.rvol?.toFixed(2) }}</span></div>
              <div v-if="selectedCandidate.vwap" class="flex justify-between"><span class="text-gray-500">VWAP</span><span class="text-mono-num">{{ formatPrice(selectedCandidate.vwap) }}</span></div>
              <div v-if="selectedCandidate.vwap_distance" class="flex justify-between"><span class="text-gray-500">VWAP Dist</span><span class="text-mono-num">{{ formatPercent(selectedCandidate.vwap_distance) }}</span></div>
              <div v-if="selectedCandidate.liquidity" class="flex justify-between"><span class="text-gray-500">Liquidity</span>{{ selectedCandidate.liquidity.liquidity_rating || '—' }}</div>
              <div v-if="selectedCandidate.liquidity && selectedCandidate.liquidity.spread_pct != null" class="flex justify-between"><span class="text-gray-500">Spread</span><span class="text-mono-num">{{ formatPercent(selectedCandidate.liquidity.spread_pct) }}</span></div>
              <div v-if="selectedCandidate.market_regime" class="flex justify-between"><span class="text-gray-500">Market</span>{{ selectedCandidate.market_regime }}</div>
              <div v-if="selectedCandidate.volatility_regime" class="flex justify-between"><span class="text-gray-500">Volatility</span>{{ selectedCandidate.volatility_regime }}</div>
            </div>
          </div>

          <!-- Proposal / entry / stop / targets -->
          <div v-if="selectedProposal" class="border-t border-gray-100 dark:border-gray-700 pt-3">
            <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">Proposal</div>
            <div class="space-y-1 text-xs">
              <div class="flex justify-between"><span class="text-gray-500">Strategy</span><span>{{ selectedProposal.strategy_name || selectedProposal.strategy_id?.slice(0, 8) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">State</span>
                <span class="px-1.5 py-0.5 rounded text-xs font-semibold" :class="stateClass(selectedProposal.lifecycle_state)">{{ formatLabel(selectedProposal.lifecycle_state) }}</span>
              </div>
              <div class="flex justify-between"><span class="text-gray-500">Entry</span><span class="text-mono-num">{{ formatPrice(getEntryLow(selectedProposal.entry_zone)) }}–{{ formatPrice(getEntryHigh(selectedProposal.entry_zone)) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Stop</span><span class="text-mono-num text-red-600 dark:text-red-400">{{ formatPrice(selectedProposal.stop_price) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">T1</span><span class="text-mono-num text-green-600 dark:text-green-400">{{ formatPrice(selectedProposal.t1_price) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">T2</span><span class="text-mono-num text-green-600 dark:text-green-400">{{ formatPrice(selectedProposal.t2_price) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Runner</span><span class="text-mono-num">{{ formatPrice(selectedProposal.runner_target) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">R:R</span><span class="text-mono-num">{{ selectedProposal.rr_ratio || '—' }}</span></div>
            </div>
            <div v-if="selectedProposal.warnings && selectedProposal.warnings.length" class="mt-2 p-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <div class="text-xs font-medium text-amber-700 dark:text-amber-300 mb-1">Warnings</div>
              <ul class="text-xs text-amber-700 dark:text-amber-300 list-disc list-inside">
                <li v-for="(w, i) in selectedProposal.warnings" :key="i">{{ typeof w === 'string' ? w : JSON.stringify(w) }}</li>
              </ul>
            </div>
          </div>

          <!-- Risk section -->
          <div v-if="riskEvaluation" class="border-t border-gray-100 dark:border-gray-700 pt-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Risk</span>
              <span class="px-1.5 py-0.5 rounded text-xs font-semibold" :class="riskStateClass(riskEvaluation.state)">{{ riskEvaluation.state }}</span>
              <span v-if="riskStale" class="text-xs text-amber-600 dark:text-amber-400">stale</span>
            </div>
            <div class="space-y-1 text-xs">
              <div class="flex justify-between"><span class="text-gray-500">Preset</span><span>{{ riskEvaluation.risk_percent }}%</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Equity</span><span class="text-mono-num">{{ formatPrice(riskEvaluation.account_equity) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Max $ Risk</span><span class="text-mono-num">{{ formatPrice(riskEvaluation.max_dollar_risk) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Risk/Share</span><span class="text-mono-num">{{ formatPrice(riskEvaluation.risk_per_share) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Shares</span><span class="text-mono-num font-semibold">{{ riskEvaluation.suggested_shares }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Position $</span><span class="text-mono-num">{{ formatPrice(riskEvaluation.total_position_value) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Total Risk</span><span class="text-mono-num">{{ formatPrice(riskEvaluation.total_dollar_risk) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Exposure</span><span class="text-mono-num">{{ formatPercent(riskEvaluation.exposure_pct) }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">R:R T1</span><span class="text-mono-num">{{ riskEvaluation.rr_t1 }}</span></div>
              <div class="flex justify-between"><span class="text-gray-500">R:R T2</span><span class="text-mono-num">{{ riskEvaluation.rr_t2 }}</span></div>
            </div>
            <div v-if="riskEvaluation.rejection_reasons && riskEvaluation.rejection_reasons.length" class="mt-2 p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <div class="text-xs font-medium text-red-700 dark:text-red-300 mb-1">Rejection</div>
              <ul class="text-xs text-red-700 dark:text-red-300 list-disc list-inside">
                <li v-for="r in riskEvaluation.rejection_reasons" :key="r">{{ r }}</li>
              </ul>
            </div>
          </div>

          <!-- Empirical evidence -->
          <div v-if="calibration && calibration.sampleSize > 0" class="border-t border-gray-100 dark:border-gray-700 pt-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Historical Evidence</span>
              <span class="px-1.5 py-0.5 rounded text-xs font-semibold" :class="evidenceQualityClass(calibration.evidenceQuality)">{{ calibration.evidenceQuality }}</span>
            </div>
            <div class="space-y-1 text-xs">
              <div class="flex justify-between">
                <span class="text-gray-500">Sample</span>
                <span class="text-mono-num font-semibold">{{ calibration.sampleSize }}</span>
              </div>
              <div class="flex justify-between gap-2">
                <span class="text-gray-500">Sources</span>
                <span>
                  <span class="text-indigo-600 dark:text-indigo-400">BT {{ calibration.backtestCount }}</span>
                  <span class="text-gray-300 mx-1">·</span>
                  <span class="text-purple-600 dark:text-purple-400">PR {{ calibration.paperCount }}</span>
                </span>
              </div>
              <div class="flex justify-between"><span class="text-gray-500">Win Rate</span><span class="text-mono-num font-semibold">{{ calibration.winRate }}%</span></div>
              <div v-if="calibration.confidenceInterval" class="flex justify-between"><span class="text-gray-500">CI 95%</span><span class="text-mono-num">{{ calibration.confidenceInterval.lower }}–{{ calibration.confidenceInterval.upper }}%</span></div>
              <div class="flex justify-between"><span class="text-gray-500">T1 Hit</span><span class="text-mono-num">{{ calibration.t1HitRate }}%</span></div>
              <div class="flex justify-between"><span class="text-gray-500">T2 Hit</span><span class="text-mono-num">{{ calibration.t2HitRate }}%</span></div>
              <div class="flex justify-between"><span class="text-gray-500">Expectancy</span><span class="text-mono-num">{{ calibration.expectancyR }}R</span></div>
            </div>
            <div class="text-[10px] text-gray-400 mt-1">Advisory only — historical empirical rate, not a prediction.</div>
          </div>

          <!-- PAPER Execution -->
          <div v-if="selectedProposal" class="border-t border-gray-100 dark:border-gray-700 pt-3">
            <div class="flex items-center gap-2 mb-2">
              <span class="px-2 py-0.5 rounded text-xs font-bold bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">PAPER</span>
              <span class="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Execution</span>
            </div>
            <!-- Approval actions -->
            <div v-if="canApprove" class="flex gap-1 mb-2">
              <button @click="approveProposal('approved')" :disabled="actionLoading"
                class="flex-1 px-2 py-1 rounded text-xs font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">Approve</button>
              <button @click="approveProposal('rejected')" :disabled="actionLoading"
                class="flex-1 px-2 py-1 rounded text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">Reject</button>
              <button @click="approveProposal('watch')" :disabled="actionLoading"
                class="flex-1 px-2 py-1 rounded text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 disabled:opacity-50">Watch</button>
            </div>
            <!-- Risk rejection disables execution -->
            <div v-if="riskEvaluation && riskEvaluation.state === 'REJECTED'" class="p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-2">
              Risk REJECTED — execution disabled
            </div>
            <!-- PAPER trading halted — new entries blocked -->
            <div v-if="paperTradingHalted" class="p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-2">
              PAPER TRADING HALTED — new entries blocked. Existing positions remain manageable.
            </div>
            <!-- PAPER entry -->
            <div v-if="canExecutePaper && !paperTradingHalted" class="space-y-2">
              <button v-if="selectedProposal.lifecycle_state === 'APPROVED'"
                @click="paperEntry" :disabled="actionLoading"
                class="w-full px-3 py-1.5 rounded text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                Execute PAPER Entry
              </button>
              <div v-if="selectedProposal.lifecycle_state === 'ENTRY_SUBMITTED'" class="flex gap-1">
                <button @click="paperProcessFills" :disabled="actionLoading"
                  class="flex-1 px-2 py-1 rounded text-xs font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">Check Fills</button>
                <button @click="paperCancelEntry" :disabled="actionLoading"
                  class="flex-1 px-2 py-1 rounded text-xs font-semibold bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">Cancel</button>
              </div>
              <div v-if="paperPosition" class="space-y-1">
                <div class="text-xs flex justify-between"><span>Entry:</span><span class="text-mono-num">{{ formatPrice(paperPosition.avg_entry_price) }}</span></div>
                <div class="text-xs flex justify-between"><span>Qty:</span><span class="text-mono-num">{{ paperPosition.total_qty }} ({{ paperPosition.remaining_qty }} left)</span></div>
                <div class="text-xs flex justify-between"><span>Realized:</span><span class="text-mono-num" :class="Number(paperPosition.realized_pnl) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ formatPrice(paperPosition.realized_pnl) }}</span></div>
                <div v-if="unrealizedPnl != null" class="text-xs flex justify-between"><span>Unrealized:</span><span class="text-mono-num" :class="unrealizedPnl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ formatPrice(unrealizedPnl) }}</span></div>
                <div class="flex gap-1 mt-1">
                  <button @click="paperProcessFills" :disabled="actionLoading"
                    class="flex-1 px-2 py-1 rounded text-xs font-medium bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-300">Check Fills</button>
                  <button @click="paperManualClose" :disabled="actionLoading"
                    class="flex-1 px-2 py-1 rounded text-xs font-medium bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300">Close</button>
                </div>
                <div class="flex gap-1">
                  <input v-model.number="stopUpdatePrice" type="number" step="0.01" placeholder="New stop"
                    class="flex-1 text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800" />
                  <button @click="paperUpdateStop" :disabled="actionLoading || !stopUpdatePrice"
                    class="px-2 py-1 rounded text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">Update Stop</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as LightweightCharts from 'lightweight-charts'
import api from '@/services/api'
import { useVisibilityPolling } from '@/composables/useVisibilityPolling'

// ─── State ─────────────────────────────────────────────────────────────────

const indexQuotes = ref([])
const indicesLoading = ref(false)
const indicesStale = ref(false)

const scanner = ref([])
const scannerLoading = ref(false)
const scannerError = ref(null)
const scannerStale = ref(false)

const selectedSymbol = ref(null)
const selectedCandidate = ref(null)
const selectedProposal = ref(null)
const quoteData = ref(null)

const chartContainer = ref(null)
const chartData = ref(null)
const chartIndicators = ref(null)
const chartLoading = ref(false)
const chartError = ref(null)
const chartStale = ref(false)
const timeframe = ref('5')
let chart = null
let candleSeries = null
let vwapSeries = null
let ema9Series = null
let ema20Series = null

const riskEvaluation = ref(null)
const riskStale = ref(false)
const calibration = ref(null)
const paperPosition = ref(null)
const paperOrders = ref(null)
const unrealizedPnl = ref(null)
const actionLoading = ref(false)
const stopUpdatePrice = ref(null)
const paperAccount = ref(null)
const paperTradingHalted = ref(false)

// Abort controller for rapid symbol switching (stale response protection)
let fetchAbortController = null

const news = ref([])
const newsLoading = ref(false)
const secFilings = ref([])
const secLoading = ref(false)

const sessionLabel = ref('')
const sessionBadgeClass = ref('')
const sessionDotClass = ref('')

const activeTab = ref('news')
const tabs = [
  { key: 'news', label: 'News' },
  { key: 'catalysts', label: 'Catalysts' },
  { key: 'sec', label: 'SEC' },
  { key: 'fundamentals', label: 'Fund' },
  { key: 'dilution', label: 'Dilution' },
  { key: 'execution', label: 'Exec' },
  { key: 'audit', label: 'Audit' }
]
const timeframes = [
  { value: '1', label: '1m' },
  { value: '5', label: '5m' },
  { value: '15', label: '15m' }
]

const PAPER_ACTIVE_STATES = [
  'ENTRY_SUBMITTED', 'ENTRY_PARTIALLY_FILLED', 'ENTRY_FILLED',
  'POSITION_ACTIVE', 'T1_FILLED', 'T2_FILLED'
]

const canApprove = computed(() => {
  const p = selectedProposal.value
  if (!p) return false
  return ['READY_FOR_APPROVAL', 'WATCH', 'SIGNAL_DETECTED'].includes(p.lifecycle_state)
})

const canExecutePaper = computed(() => {
  const p = selectedProposal.value
  if (!p) return false
  if (p.execution_mode !== 'PAPER') return false
  if (riskEvaluation.value && riskEvaluation.value.state === 'REJECTED') return false
  return true
})

// ─── Polling ────────────────────────────────────────────────────────────────

const indicesPoll = useVisibilityPolling(fetchIndices, 30000, { immediate: true })
const scannerPoll = useVisibilityPolling(fetchScanner, 30000, { immediate: true })
const activePaperPoll = useVisibilityPolling(pollActivePaper, 15000)

// ─── Indices ────────────────────────────────────────────────────────────────

async function fetchIndices() {
  indicesLoading.value = true
  try {
    const { data } = await api.get('/market/indices', { params: { extended: 'true' } })
    indexQuotes.value = (data.indices || data || []).map(idx => ({
      symbol: idx.symbol,
      price: Number(idx.price ?? idx.c),
      change: Number(idx.change ?? idx.d ?? 0),
      changePercent: Number(idx.change_percent ?? idx.dp ?? 0),
      stale: false
    }))
    if (data.session || data.session_label) {
      sessionLabel.value = data.session_label || data.session || ''
      applySessionClasses(data.session)
    }
    indicesStale.value = false
  } catch {
    indicesStale.value = true
  } finally {
    indicesLoading.value = false
  }
}

function applySessionClasses(session) {
  const map = {
    premarket: { badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', dot: 'bg-blue-500' },
    regular: { badge: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', dot: 'bg-green-500' },
    after_hours: { badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300', dot: 'bg-purple-500' },
    closed: { badge: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300', dot: 'bg-gray-400' }
  }
  const cls = map[session] || map.closed
  sessionBadgeClass.value = cls.badge
  sessionDotClass.value = cls.dot
}

// ─── Scanner ────────────────────────────────────────────────────────────────

async function fetchScanner() {
  scannerLoading.value = true
  scannerError.value = null
  try {
    const { data } = await api.get('/market/scanner', { params: { limit: 100 } })
    scanner.value = data.candidates || []
    if (data.session) applySessionClasses(data.session)
    scannerStale.value = false
  } catch (err) {
    scannerError.value = err?.response?.data?.error || 'Scanner failed'
    scanner.value = []
    scannerStale.value = true
  } finally {
    scannerLoading.value = false
  }
}

// ─── Symbol Selection ─────────────────────────────────────────────────────

function selectSymbol(candidate) {
  if (!candidate) return
  // Abort any in-flight requests for the previous symbol
  if (fetchAbortController) {
    fetchAbortController.abort()
  }
  fetchAbortController = new AbortController()
  selectedSymbol.value = candidate.symbol
  selectedCandidate.value = candidate
  selectedProposal.value = null
  riskEvaluation.value = null
  calibration.value = null
  paperPosition.value = null
  paperOrders.value = null
  unrealizedPnl.value = null
  quoteData.value = null
  chartData.value = null

  fetchQuote()
  fetchChart()
  fetchNews()
  fetchSEC()
  findProposalForSymbol()
}

async function fetchQuote() {
  if (!selectedSymbol.value) return
  const ac = fetchAbortController
  try {
    const { data } = await api.get('/market/quote', { params: { symbol: selectedSymbol.value }, signal: ac?.signal })
    if (fetchAbortController === ac) quoteData.value = data
  } catch (err) {
    if (err?.name !== 'CanceledError') quoteData.value = null
  }
}

async function fetchChart() {
  if (!selectedSymbol.value) return
  const ac = fetchAbortController
  chartLoading.value = true
  chartError.value = null
  try {
    const { data } = await api.get('/market/candles', {
      params: { symbol: selectedSymbol.value, resolution: timeframe.value, hours: 8 },
      signal: ac?.signal
    })
    // Ignore if a newer request was started
    if (fetchAbortController !== ac) return
    chartData.value = data.candles || []
    chartIndicators.value = data.indicators || null
    chartStale.value = data.stale === true
    await nextTick()
    renderChart()
  } catch (err) {
    if (err?.name !== 'CanceledError') {
      chartError.value = 'Chart data unavailable'
    }
  } finally {
    if (fetchAbortController === ac) chartLoading.value = false
  }
}

async function fetchNews() {
  if (!selectedSymbol.value) return
  newsLoading.value = true
  try {
    const { data } = await api.get('/market/news', { params: { symbol: selectedSymbol.value, limit: 15 } })
    news.value = data.news || data || []
  } catch {
    news.value = []
  } finally {
    newsLoading.value = false
  }
}

async function fetchSEC() {
  if (!selectedSymbol.value) return
  secLoading.value = true
  try {
    const { data } = await api.get('/market/filings', { params: { symbol: selectedSymbol.value, limit: 10 } })
    secFilings.value = data.filings || data || []
  } catch {
    secFilings.value = []
  } finally {
    secLoading.value = false
  }
}

async function findProposalForSymbol() {
  if (!selectedSymbol.value) return
  try {
    const { data } = await api.get('/trading/proposals', { params: { symbol: selectedSymbol.value, limit: 5 } })
    const proposals = data.proposals || []
    selectedProposal.value = proposals.length > 0 ? proposals[0] : null
    if (selectedProposal.value) {
      fetchRiskEvaluation(selectedProposal.value.id)
      fetchCalibration(selectedProposal.value.id)
      fetchPaperPosition(selectedProposal.value.id)
    }
  } catch {
    selectedProposal.value = null
  }
}

async function fetchRiskEvaluation(id) {
  riskEvaluation.value = null
  riskStale.value = false
  try {
    const { data } = await api.get(`/trading/proposals/${id}/risk-evaluation`)
    riskEvaluation.value = data.evaluation
    riskStale.value = data.is_stale
  } catch {
    // no evaluation yet
  }
}

async function fetchCalibration(id) {
  calibration.value = null
  try {
    const { data } = await api.get(`/trading/proposals/${id}/calibration`)
    calibration.value = data
  } catch {
    // no calibration yet
  }
}

async function fetchPaperPosition(id) {
  paperPosition.value = null
  paperOrders.value = null
  unrealizedPnl.value = null
  try {
    const { data } = await api.get(`/trading/proposals/${id}/paper-position`)
    paperPosition.value = data.position
    paperOrders.value = data.orders
    unrealizedPnl.value = data.unrealized_pnl ?? null
  } catch {
    // no position yet
  }
}

// ─── Chart Rendering ────────────────────────────────────────────────────────

function renderChart() {
  if (!chartContainer.value || !chartData.value || chartData.value.length === 0) return

  if (chart) {
    chart.remove()
    chart = null
  }

  const isDark = document.documentElement.classList.contains('dark')

  chart = LightweightCharts.createChart(chartContainer.value, {
    width: chartContainer.value.clientWidth,
    height: chartContainer.value.clientHeight,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: isDark ? '#e5e7eb' : '#111827',
    },
    grid: {
      vertLines: { color: isDark ? '#374151' : '#e5e7eb' },
      horzLines: { color: isDark ? '#374151' : '#e5e7eb' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    timeScale: {
      borderColor: isDark ? '#4b5563' : '#d1d5db',
      timeVisible: true,
      secondsVisible: false,
    },
    rightPriceScale: {
      borderColor: isDark ? '#4b5563' : '#d1d5db',
    },
  })

  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#059669',
    downColor: '#dc2626',
    borderUpColor: '#059669',
    borderDownColor: '#dc2626',
    wickUpColor: '#059669',
    wickDownColor: '#dc2626',
  })

  const candles = chartData.value.map(c => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume
  }))
  candleSeries.setData(candles)

  // Volume as histogram at bottom
  const volSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  })
  chart.priceScale('vol').applyOptions({
    scaleMargins: { top: 0.85, bottom: 0 },
  })
  volSeries.setData(candles.map(c => ({
    time: c.time,
    value: c.volume,
    color: c.close >= c.open ? 'rgba(5, 150, 105, 0.3)' : 'rgba(220, 38, 38, 0.3)'
  })))

  // Entry/stop/target overlays if proposal exists
  if (selectedProposal.value) {
    const p = selectedProposal.value
    if (p.stop_price) {
      const stopLine = chart.addSeries(LightweightCharts.LineSeries, { color: '#dc2626', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed })
      stopLine.setData(candles.map(c => ({ time: c.time, value: Number(p.stop_price) })))
    }
    if (p.t1_price) {
      const t1Line = chart.addSeries(LightweightCharts.LineSeries, { color: '#059669', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed })
      t1Line.setData(candles.map(c => ({ time: c.time, value: Number(p.t1_price) })))
    }
    if (p.t2_price) {
      const t2Line = chart.addSeries(LightweightCharts.LineSeries, { color: '#0d9488', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed })
      t2Line.setData(candles.map(c => ({ time: c.time, value: Number(p.t2_price) })))
    }
  }

  // VWAP and EMA overlays from backend-computed indicators
  const indicators = chartIndicators.value
  if (indicators) {
    if (indicators.vwap_series && indicators.vwap_series.length > 0) {
      const vwapLine = chart.addSeries(LightweightCharts.LineSeries, {
        color: '#6366f1', lineWidth: 2, priceLineVisible: false, lastValueVisible: false
      })
      vwapLine.setData(indicators.vwap_series)
    }
    if (indicators.ema9_series && indicators.ema9_series.length > 0) {
      const ema9Line = chart.addSeries(LightweightCharts.LineSeries, {
        color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false
      })
      ema9Line.setData(indicators.ema9_series)
    }
    if (indicators.ema20_series && indicators.ema20_series.length > 0) {
      const ema20Line = chart.addSeries(LightweightCharts.LineSeries, {
        color: '#8b5cf6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false
      })
      ema20Line.setData(indicators.ema20_series)
    }
  }

  chart.timeScale().fitContent()
}

function changeTimeframe(tf) {
  if (timeframe.value === tf) return
  timeframe.value = tf
  if (selectedSymbol.value) fetchChart()
}

// ─── PAPER Execution Actions ──────────────────────────────────────────────

async function approveProposal(decision) {
  const p = selectedProposal.value
  if (!p) return
  actionLoading.value = true
  try {
    await api.post(`/trading/proposals/${p.id}/approval`, { decision })
    await findProposalForSymbol()
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

async function paperEntry() {
  const p = selectedProposal.value
  if (!p) return
  actionLoading.value = true
  try {
    await api.post(`/trading/proposals/${p.id}/paper-entry`)
    await fetchPaperPosition(p.id)
    await findProposalForSymbol()
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

async function paperProcessFills() {
  const p = selectedProposal.value
  if (!p) return
  actionLoading.value = true
  try {
    await api.post(`/trading/proposals/${p.id}/paper-fills`)
    await fetchPaperPosition(p.id)
    await findProposalForSymbol()
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

async function paperCancelEntry() {
  const p = selectedProposal.value
  if (!p) return
  actionLoading.value = true
  try {
    await api.post(`/trading/proposals/${p.id}/paper-cancel-entry`)
    await fetchPaperPosition(p.id)
    await findProposalForSymbol()
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

async function paperManualClose() {
  const p = selectedProposal.value
  if (!p) return
  actionLoading.value = true
  try {
    await api.post(`/trading/proposals/${p.id}/paper-manual-close`)
    await fetchPaperPosition(p.id)
    await findProposalForSymbol()
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

async function paperUpdateStop() {
  const p = selectedProposal.value
  if (!p || !stopUpdatePrice.value) return
  actionLoading.value = true
  try {
    await api.patch(`/trading/proposals/${p.id}/paper-stop`, { stopPrice: stopUpdatePrice.value })
    stopUpdatePrice.value = null
    await fetchPaperPosition(p.id)
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

async function pollActivePaper() {
  if (document.hidden) return
  const p = selectedProposal.value
  if (p && PAPER_ACTIVE_STATES.includes(p.lifecycle_state)) {
    await fetchPaperPosition(p.id)
    await findProposalForSymbol()
  }
  await fetchPaperAccount()
}

// ─── Paper Account / Halt Control ───────────────────────────────────────────

async function fetchPaperAccount() {
  try {
    const { data } = await api.get('/trading/paper-account')
    paperAccount.value = data
    paperTradingHalted.value = data.paper_trading_halted === true
  } catch {
    // no account yet
  }
}

async function haltPaperTrading() {
  actionLoading.value = true
  try {
    await api.post('/trading/paper-account/halt')
    await fetchPaperAccount()
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

async function unhaltPaperTrading() {
  actionLoading.value = true
  try {
    await api.post('/trading/paper-account/unhalt')
    await fetchPaperAccount()
  } catch {
    // error
  } finally {
    actionLoading.value = false
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPercent(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number(v).toFixed(2) + '%'
}

function formatMarketCap(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(1) + 'T'
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M'
  return '$' + v.toFixed(0)
}

function formatDate(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatLabel(s) {
  if (!s) return ''
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

function setupLabel(type) {
  const labels = {
    gap_and_catalyst: 'Gap+Cat', momentum: 'Mom', rvol_surge: 'RVOL',
    vwap_reclaim: 'VWAP-R', vwap_loss: 'VWAP-L',
    opening_range_breakout: 'OR-B', opening_range_breakdown: 'OR-D',
    breakout: 'Brk', relative_strength: 'RS', earnings_reaction: 'ER',
    sec_catalyst: 'SEC', halt_resumption: 'Halt', unusual_volume: 'UVol'
  }
  return labels[type] || type
}

function setupScoreClass(score) {
  if (score >= 70) return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  if (score >= 50) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
  return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
}

function classificationClass(cls) {
  switch (cls) {
    case 'TRADE': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'WATCH': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'AVOID_CHASING': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'AVOID': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    default: return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }
}

function catalystClass(type) {
  switch (type) {
    case 'earnings': return 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
    case 'sec_material_filing':
    case 'sec_filing': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'offering_financing': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    case 'insider_form_4': return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
    case 'halt': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    default: return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }
}

function dilutionLevelClass(level) {
  switch (level) {
    case 'HIGH': return 'text-red-600 dark:text-red-400'
    case 'MEDIUM': return 'text-amber-600 dark:text-amber-400'
    case 'LOW': return 'text-green-600 dark:text-green-400'
    default: return 'text-gray-500'
  }
}

function stateClass(state) {
  switch (state) {
    case 'READY_FOR_APPROVAL': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'APPROVED': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'REJECTED': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    case 'WATCH': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'POSITION_ACTIVE': return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
    case 'STOP_FILLED':
    case 'POSITION_CLOSED': return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
    case 'ERROR':
    case 'MANUAL_INTERVENTION_REQUIRED': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    default: return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  }
}

function riskStateClass(state) {
  switch (state) {
    case 'VALID': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'WATCH': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'REJECTED': return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    default: return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  }
}

function evidenceQualityClass(quality) {
  switch (quality) {
    case 'STRONG': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'MODERATE': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'LOW': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    default: return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  }
}

function orderStatusClass(status) {
  switch (status) {
    case 'FILLED': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    case 'SUBMITTED': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    case 'PARTIALLY_FILLED': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    case 'CANCELLED': return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
    default: return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
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

// ─── Resize handler ─────────────────────────────────────────────────────────

function handleResize() {
  if (chart && chartContainer.value) {
    chart.applyOptions({
      width: chartContainer.value.clientWidth,
      height: chartContainer.value.clientHeight,
    })
  }
}

let resizeObserver = null

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(() => {
  indicesPoll.start()
  scannerPoll.start()
  activePaperPoll.start()
  fetchPaperAccount()
  if (chartContainer.value) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(chartContainer.value)
  }
})

onUnmounted(() => {
  indicesPoll.stop()
  scannerPoll.stop()
  activePaperPoll.stop()
  if (chart) { chart.remove(); chart = null }
  if (resizeObserver) resizeObserver.disconnect()
})

// Re-render chart when data changes
watch(chartData, () => {
  nextTick(() => renderChart())
})

// Re-render chart when proposal changes (for overlays)
watch(selectedProposal, () => {
  if (chartData.value) nextTick(() => renderChart())
})
</script>

<style scoped>
.trading-workstation {
  font-size: 13px;
}
.scanner-row {
  min-height: 48px;
}
</style>
