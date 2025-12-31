// backend/routes/staff.routes.js
const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');

const {
  getAllTickets,
  changeTicketStatus,
  getBurialSchedules,
  getAvailablePlots,
  createBurialSchedule,
  updateBurialSchedule,
  deleteBurialSchedule,
  getVisitors,
  getMaintenanceSchedules,
  createMaintenance,
  updateMaintenance,
  deleteMaintenance,
} = require('../controllers/staff.controller');

// tickets
router.get('/get-all-tickets/', verifyToken, getAllTickets);
router.patch('/change-status/:id', verifyToken, changeTicketStatus);



// plots (not used in graves)
router.get('/plots/available', verifyToken, getAvailablePlots);

// visitors list for dropdown
router.get('/visitors', verifyToken, getVisitors);

router.get('/maintenance-schedules/', verifyToken, getMaintenanceSchedules);
router.post('/add-maintenance', verifyToken, createMaintenance);
router.put('/edit-maintenance/:id', verifyToken, updateMaintenance)
router.delete('/delete-maintenance/:id', verifyToken, deleteMaintenance);

module.exports = router;
