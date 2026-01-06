// backend/routes/visitor.routes.js
"use strict";

const express = require("express");
const router = express.Router();

const { verifyToken, requireRole } = require("../middleware/auth");

const visitorController = require("../controllers/visitor.controller");

const allowVisitor = requireRole(["visitor"]);

/* =========================================================================
   PUBLIC ROUTES (no token)
======================================================================== */
router.get("/burial-records", visitorController.getBurialRecords);

/* =========================================================================
   PROTECTED ROUTES
======================================================================== */
router.use(verifyToken);

/* --- deceased names for dropdown --- */
router.get(
  "/my-deceased-names/:family_contact",
  allowVisitor,
  visitorController.getMyDeceasedNames
);

/* --- burial request --- */
router.post("/request-burial", allowVisitor, visitorController.createBurialRequest);
router.get(
  "/my-burial-requests/:family_contact",
  allowVisitor,
  visitorController.getBurialRequests
);
router.patch(
  "/request-burial/cancel/:id",
  allowVisitor,
  visitorController.cancelBurialRequest
);

/* --- maintenance request --- */
router.post("/request-maintenance", allowVisitor, visitorController.createMaintenanceRequest);
router.get(
  "/my-maintenance-requests/:family_contact",
  allowVisitor,
  visitorController.getMaintenanceRequests
);
router.patch(
  "/request-maintenance/cancel/:id",
  allowVisitor,
  visitorController.cancelMaintenanceRequest
);

/* --- dashboard --- */
router.get("/dashboard-stats", allowVisitor, visitorController.getDashboardStats);

/* --- reservations --- */
router.post("/reserve-plot", allowVisitor, visitorController.reservePlot);
router.get("/my-reservations", allowVisitor, visitorController.getMyReservations);
router.patch(
  "/cancel-reservation/:id",
  allowVisitor,
  visitorController.cancelReservation
);


/* --- ✅ maintenance schedule extras --- */
router.get(
  "/my-maintenance-schedule/:family_contact",
  allowVisitor,
  visitorController.getMyMaintenanceSchedule
);
router.patch(
  "/maintenance/:id/request-reschedule",
  allowVisitor,
  visitorController.requestMaintenanceReschedule
);
router.post("/maintenance/:id/feedback", allowVisitor, visitorController.submitMaintenanceFeedback);

module.exports = router;
