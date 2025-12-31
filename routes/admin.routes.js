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
// If your file is named `adminReservationsController.js`, change the require accordingly.
const adminReservation = require("../controllers/adminReservation.controller");

const adminMaintenance = require("../controllers/adminMaintenance.controller");

// ✅ all /admin routes require auth
router.use(verifyToken);

// ✅ admin + staff access
const allowAdminStaff = requireRole(["admin", "staff"]);
const adminOnly = requireRole(["admin"]);

/* =========================================================================================
   ✅ PHOTO UPLOAD: POST /api/admin/plot/:id/photo
   - multer saves to backend/uploads/plots
   - controller stores URL to plots.photo_url
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
router.get(
  "/maintenance-requests",
  allowAdminStaff,
  adminMaintenance.getMaintenanceRequests
);

router.patch(
  "/maintenance/:id/schedule",
  allowAdminStaff,
  adminMaintenance.scheduleMaintenance
);

router.patch(
  "/maintenance/:id/complete",
  allowAdminStaff,
  adminMaintenance.completeMaintenance
);

/* --- plots --- */
router.post("/add-plot", allowAdminStaff, adminController.addPlots);
router.put("/edit-plot", allowAdminStaff, adminController.editPlots);
router.delete("/delete-plot/:id", allowAdminStaff, adminController.deletePlots);

// ✅ used by frontend: GET /api/admin/plot/:idOrUid
router.get("/plot/:id", allowAdminStaff, adminController.getPlotDetails);

// ✅ used by frontend: POST /api/admin/plot/:id/photo
router.post(
  "/plot/:id/photo",
  allowAdminStaff,
  upload.single("photo"),
  adminController.uploadPlotPhoto
);



/* --- building plots --- */
router.post("/add-building-plot", allowAdminStaff, adminController.addBuildingPlots);
router.put("/edit-building-plot", allowAdminStaff, adminController.editBuildingPlots);
router.delete(
  "/delete-building-plot/:id",
  allowAdminStaff,
  adminController.deleteBuildingPlots
);

/* =========================================================================================
   ✅ BURIAL RECORDS (GRAVES) - RESTFUL (matches your BurialPlots.jsx endpoints)
   Frontend calls:
   GET    /api/admin/burial-records?plot_id=... OR ?plot_uid=...
   POST   /api/admin/burial-records
   PATCH  /api/admin/burial-records/:idOrUid
   DELETE /api/admin/burial-records/:idOrUid
========================================================================================= */
router.get("/burial-records", allowAdminStaff, adminController.getBurialRecords);
router.post("/burial-records", adminOnly, adminController.addBurialRecord);
router.patch("/burial-records/:id", adminOnly, adminController.editBurialRecord);
router.delete("/burial-records/:id", adminOnly, adminController.deleteBurialRecord);

/* ✅ OPTIONAL: keep old endpoints as aliases (so nothing breaks) */
router.get("/graves", allowAdminStaff, adminController.getBurialRecords);
router.post("/graves", adminOnly, adminController.addBurialRecord);
router.post("/edit-burial-record", adminOnly, adminController.editBurialRecord);
router.delete("/delete-burial-record/:id", adminOnly, adminController.deleteBurialRecord);

// Optional legacy PATCH alias (if you previously used PATCH /burial-records with id in body)
router.patch("/burial-records", adminOnly, adminController.editBurialRecord);

/* --- users --- */
// ✅ matches your frontend: GET /api/admin/visitor-users
router.get("/visitor-users", allowAdminStaff, adminController.getVisitorUsers);

// ✅ keep old alias (if you used it before)
router.get("/users/visitors", allowAdminStaff, adminController.getVisitorUsers);

/* =========================================================================================
   ✅ RESERVATIONS (matches BurialPlots.jsx)
   Frontend calls:
   GET   /api/admin/reservations
   PATCH /api/admin/cancel-reservation/:id
   PATCH /api/admin/reservations/:id/validate-payment
   PATCH /api/admin/reservations/:id/approve-payment
   PATCH /api/admin/reservations/:id/reject
========================================================================================= */

// admin/staff create reservation (optional)
router.post("/reserve-plot", allowAdminStaff, adminReservation.reservePlotAsAdmin);

// list reservations
router.get("/reservations", allowAdminStaff, adminReservation.getAllReservations);

// cancel
router.patch(
  "/cancel-reservation/:id",
  allowAdminStaff,
  adminReservation.cancelReservationAsAdmin
);

// reject
router.patch(
  "/reservations/:id/reject",
  allowAdminStaff,
  adminReservation.rejectReservationAsAdmin
);

// validate payment
router.patch(
  "/reservations/:id/validate-payment",
  allowAdminStaff,
  adminReservation.validatePaymentAsAdmin
);

// approve payment + approve reservation (your flow)
router.patch(
  "/reservations/:id/approve-payment",
  allowAdminStaff,
  adminReservation.approvePaymentAsAdmin
);

// ✅ keep old endpoint as alias for payment-approval (so older frontend calls won't break)
router.patch(
  "/reservations/:id/approve",
  allowAdminStaff,
  adminReservation.approvePaymentAsAdmin
);

// ✅ OPTIONAL legacy endpoint: if your old controller still has approveReservationAsAdmin
// If not present, we fall back to approvePaymentAsAdmin safely.
router.patch("/reservations/:id/approve-reservation", allowAdminStaff, (req, res, next) => {
  const fn =
    adminReservation.approveReservationAsAdmin || adminReservation.approvePaymentAsAdmin;
  return fn(req, res, next);
});

module.exports = router;
