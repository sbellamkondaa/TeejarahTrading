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

module.exports = router;