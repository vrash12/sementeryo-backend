const express = require('express');
const router = express.Router();
const { getCemeteryInfo} = require('../controllers/cemetery-info.controller');

router.get('/', getCemeteryInfo);

module.exports = router;
