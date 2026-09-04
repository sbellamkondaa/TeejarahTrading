const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const tradingController = require('../controllers/trading.controller');

router.use(authenticate);

// Execution mode status
router.get('/execution-mode', tradingController.getExecutionStatus);

// Strategies
router.get('/strategies', tradingController.listStrategies);
router.post('/strategies', tradingController.createStrategy);
router.get('/strategies/:id', tradingController.getStrategy);
router.post('/strategies/:name/versions', tradingController.createStrategyVersion);
router.patch('/strategies/:id/status', tradingController.updateStrategyStatus);
router.post('/strategies/:id/scan', tradingController.runStrategyScan);

// Signals
router.get('/signals', tradingController.listSignals);
router.get('/signals/:id', tradingController.getSignal);

// Proposals
router.get('/proposals', tradingController.listProposals);
router.post('/proposals', tradingController.createProposal);
router.get('/proposals/:id', tradingController.getProposal);
router.patch('/proposals/:id', tradingController.editProposal);
router.post('/proposals/:id/approval', tradingController.approveProposal);
router.post('/proposals/:id/transition', tradingController.transitionProposal);
router.post('/proposals/:id/risk-assessment', tradingController.assessProposalRisk);
router.get('/proposals/:id/risk-evaluation', tradingController.getProposalRisk);
router.get('/risk-presets', tradingController.getRiskPresets);

// Paper trading
router.post('/proposals/:id/paper-entry', tradingController.paperEntry);
router.post('/proposals/:id/paper-fills', tradingController.paperProcessFills);
router.post('/proposals/:id/paper-cancel-entry', tradingController.paperCancelEntry);
router.patch('/proposals/:id/paper-stop', tradingController.paperUpdateStop);
router.post('/proposals/:id/paper-manual-close', tradingController.paperManualClose);
router.get('/proposals/:id/paper-reconcile', tradingController.paperReconcile);
router.get('/proposals/:id/paper-position', tradingController.getPaperPosition);
router.get('/paper-positions', tradingController.listPaperPositions);
router.get('/paper-orders', tradingController.listPaperOrders);
router.get('/paper-account', tradingController.getPaperAccount);
router.get('/paper-reconciliation/status', tradingController.getPaperReconciliationStatus);
router.post('/paper-reconciliation/run', tradingController.triggerPaperReconciliation);

module.exports = router;