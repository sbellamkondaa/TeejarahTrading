const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const marketController = require('../controllers/market.controller');
const advisoryController = require('../controllers/advisory.controller');
const marketIntelController = require('../controllers/marketIntelligence.controller');

router.use(authenticate);

router.get('/indices', marketController.getIndices);
router.get('/halts', marketController.getHalts);
router.get('/news', marketController.getNews);
router.get('/events', marketController.getEvents);
router.get('/events/:symbol', marketController.getSymbolEvents);
router.get('/sources', marketController.getSources);
router.get('/earnings', marketController.getEarnings);
router.get('/filings', marketController.getFilings);
router.get('/movers', marketController.getMovers);
router.get('/scanner', marketController.getScanner);
router.get('/relationships/:symbol', marketController.getRelationships);
router.get('/candles', marketController.getCandles);
router.post('/advisory', advisoryController.analyze);
router.get('/advisory/status', advisoryController.getStatus);
router.post('/intelligence/ingest', marketIntelController.triggerIngestion);
router.get('/intelligence/status', marketIntelController.getStatus);

module.exports = router;
