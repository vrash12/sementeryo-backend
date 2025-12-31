const router = require('express').Router();

router.use('/superadmin', require('./superadmin.routes'));
router.use('/auth', require('./auth.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/staff', require('./staff.routes'));
router.use('/visitor', require('./visitor.routes'));
router.use('/plot', require('./plot.routes'));
router.use('/graves', require('./burial-record.routes'));
router.use('/cemetery-info', require('./cemetery-info.routes'));

module.exports = router;
