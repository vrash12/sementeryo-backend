//backend/routes/visitor.routes.js
"use strict";

const express = require("express");
const router = express.Router();

const { verifyToken, requireRole } = require("../middleware/auth");

const {
  // inquiries
  createBurialRequest,
  createMaintenanceRequest,
  getBurialRequests,
  getMaintenanceRequests,
  cancelBurialRequest,
  cancelMaintenanceRequest,

  // dashboard
  getDashboardStats,

  // reservations
  reservePlot,
  getMyReservations,
  cancelReservation,

  // deceased/burial records
  getBurialRecords,

  // deceased names list for dropdown/autofill
  getMyDeceasedNames,

  // receipt upload
  uploadReservationReceipt,

  // ✅ maintenance schedule extras
  getMyMaintenanceSchedule,
  requestMaintenanceReschedule,
  submitMaintenanceFeedback,
} = require("../controllers/visitor.controller");

/* =========================================================================
   PUBLIC ROUTES (no token)
======================================================================== */
router.get("/burial-records", getBurialRecords);

/* =========================================================================
   PROTECTED ROUTES
======================================================================== */
router.use(verifyToken);

const allowVisitor = requireRole("visitor");

/* --- deceased names for dropdown --- */
router.get("/my-deceased-names/:family_contact", allowVisitor, getMyDeceasedNames);

/* --- burial request --- */
router.post("/request-burial", allowVisitor, createBurialRequest);
router.get("/my-burial-requests/:family_contact", allowVisitor, getBurialRequests);
router.patch("/request-burial/cancel/:id", allowVisitor, cancelBurialRequest);

/* --- maintenance request --- */
router.post("/request-maintenance", allowVisitor, createMaintenanceRequest);
router.get("/my-maintenance-requests/:family_contact", allowVisitor, getMaintenanceRequests);
router.patch("/request-maintenance/cancel/:id", allowVisitor, cancelMaintenanceRequest);

/* --- dashboard --- */
router.get("/dashboard-stats", allowVisitor, getDashboardStats);

/* --- reservations --- */
router.post("/reserve-plot", allowVisitor, reservePlot);
router.get("/my-reservations", allowVisitor, getMyReservations);
router.patch("/cancel-reservation/:id", allowVisitor, cancelReservation);
router.post("/reservations/:id/upload-receipt", allowVisitor, uploadReservationReceipt);

/* --- ✅ maintenance schedule extras --- */
router.get("/my-maintenance-schedule/:family_contact", allowVisitor, getMyMaintenanceSchedule);
router.patch("/maintenance/:id/request-reschedule", allowVisitor, requestMaintenanceReschedule);
router.post("/maintenance/:id/feedback", allowVisitor, submitMaintenanceFeedback);

module.exports = router;
