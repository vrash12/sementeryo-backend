// backend/routes/admin.routes.js
"use strict";

const express = require("express");
const router = express.Router();

const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { verifyToken, requireRole } = require("../middleware/auth");

const adminController = require("../controllers/admin.controller");

// NOTE: keep this require path matching your project file name.
const adminReservation = require("../controllers/adminReservation.controller");
const adminMaintenance = require("../controllers/adminMaintenance.controller");

// ✅ all /admin routes require auth
router.use(verifyToken);

// ✅ admin + staff access
const allowAdminStaff = requireRole(["admin", "staff"]);
const adminOnly = requireRole(["admin"]);

/* =========================================================================================
   ✅ PHOTO UPLOAD: POST /api/admin/plot/:id/photo
========================================================================================= */
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "plots");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const raw = String(req.params?.id || "plot")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 40);

    const ext = path.extname(file.originalname || "").toLowerCase() || "";
    const safeExt = ext && ext.length <= 10 ? ext : "";

    const stamp = Date.now();
    cb(null, `plot-${raw}-${stamp}${safeExt}`);
  },
});

function imageFileFilter(_req, file, cb) {
  const ok = /^image\//i.test(String(file.mimetype || ""));
  if (!ok) return cb(new Error("Only image uploads are allowed."));
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

/* =========================================================================================
   ✅ ROUTES
========================================================================================= */

/* --- dashboard --- */
router.get("/metrics", allowAdminStaff, adminController.dashboardMetrics);

/* --- maintenance --- */
router.get("/maintenance-requests", allowAdminStaff, adminMaintenance.getMaintenanceRequests);

router.patch("/maintenance/:id/schedule", allowAdminStaff, adminMaintenance.scheduleMaintenance);

router.patch("/maintenance/:id/complete", allowAdminStaff, adminMaintenance.completeMaintenance);

/* --- plots --- */
router.post("/add-plot", allowAdminStaff, adminController.addPlots);
router.put("/edit-plot", allowAdminStaff, adminController.editPlots);
router.delete("/delete-plot/:id", allowAdminStaff, adminController.deletePlots);

// ✅ used by frontend: GET /api/admin/plot/:idOrUid
router.get("/plot/:id", allowAdminStaff, adminController.getPlotDetails);

// ✅ used by frontend: POST /api/admin/plot/:id/photo
router.post("/plot/:id/photo", allowAdminStaff, upload.single("photo"), adminController.uploadPlotPhoto);

/* --- building plots --- */
router.post("/add-building-plot", allowAdminStaff, adminController.addBuildingPlots);
router.put("/edit-building-plot", allowAdminStaff, adminController.editBuildingPlots);
router.delete("/delete-building-plot/:id", allowAdminStaff, adminController.deleteBuildingPlots);

/* --- burial records (graves) --- */
router.get("/burial-records", allowAdminStaff, adminController.getBurialRecords);
router.post("/burial-records", adminOnly, adminController.addBurialRecord);
router.patch("/burial-records/:id", adminOnly, adminController.editBurialRecord);
router.delete("/burial-records/:id", adminOnly, adminController.deleteBurialRecord);

/* ✅ OPTIONAL: keep old endpoints as aliases */
router.get("/graves", allowAdminStaff, adminController.getBurialRecords);
router.post("/graves", adminOnly, adminController.addBurialRecord);
router.post("/edit-burial-record", adminOnly, adminController.editBurialRecord);
router.delete("/delete-burial-record/:id", adminOnly, adminController.deleteBurialRecord);
router.patch("/burial-records", adminOnly, adminController.editBurialRecord);

/* --- users --- */
// ✅ matches your frontend: GET /api/admin/visitor-users
router.get("/visitor-users", allowAdminStaff, adminController.getVisitorUsers);

// ✅ keep old alias (if you used it before)
router.get("/users/visitors", allowAdminStaff, adminController.getVisitorUsers);

// ✅ FIXED: admin -> adminController
// Keep these only if your admin.controller.js actually exports these functions.
router.get("/visitors", allowAdminStaff, adminController.getVisitorUsers);
router.post("/visitors", adminOnly, adminController.addVisitorUser);
router.put("/visitors/:id", adminOnly, adminController.updateVisitorUser);
router.delete("/visitors/:id", adminOnly, adminController.deleteVisitorUser);

/* --- reservations --- */
router.post("/reserve-plot", allowAdminStaff, adminReservation.reservePlotAsAdmin);
router.get("/reservations", allowAdminStaff, adminReservation.getAllReservations);

router.patch("/cancel-reservation/:id", allowAdminStaff, adminReservation.cancelReservationAsAdmin);

router.patch("/reservations/:id/reject", allowAdminStaff, adminReservation.rejectReservationAsAdmin);

router.patch("/reservations/:id/validate-payment", allowAdminStaff, adminReservation.validatePaymentAsAdmin);

router.patch("/reservations/:id/approve-payment", allowAdminStaff, adminReservation.approvePaymentAsAdmin);

// ✅ keep old endpoint as alias
router.patch("/reservations/:id/approve", allowAdminStaff, adminReservation.approvePaymentAsAdmin);

router.patch("/reservations/:id/approve-reservation", allowAdminStaff, (req, res, next) => {
  const fn = adminReservation.approveReservationAsAdmin || adminReservation.approvePaymentAsAdmin;
  return fn(req, res, next);
});

module.exports = router;
