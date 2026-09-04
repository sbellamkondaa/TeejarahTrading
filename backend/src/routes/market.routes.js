const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const marketController = require('../controllers/market.controller');

router.use(authenticate);

router.get('/indices', marketController.getIndices);
router.get('/halts', marketController.getHalts);
router.get('/news', marketController.getNews);
router.get('/earnings', marketController.getEarnings);
router.get('/filings', marketController.getFilings);
router.get('/movers', marketController.getMovers);
router.get('/scanner', marketController.getScanner);
router.get('/relationships/:symbol', marketController.getRelationships);

module.exports = router;
