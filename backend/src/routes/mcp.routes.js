const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const mcpController = require('../controllers/mcp/mcp.controller');

router.use(authenticate);

router.get('/tools', mcpController.listTools);
router.post('/invoke', mcpController.invoke);

module.exports = router;
