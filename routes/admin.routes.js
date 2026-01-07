// backend/routes/admin.routes.js
"use strict";

const express = require("express");
const router = express.Router();

const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { verifyToken, requireRole } = require("../middleware/auth");

const adminController = require("../controllers/admin.controller");

// NOTE: Keep this require path matching your project file name.
const adminReservation = require("../controllers/adminReservation.controller");
const adminMaintenance = require("../controllers/adminMaintenance.controller");

// ✅ All /admin routes require auth
router.use(verifyToken);

// ✅ Admin + staff access
const allowAdminStaff = requireRole(["admin", "staff"]);
const adminOnly = requireRole(["admin"]);

/* =========================================================================================
   ✅ PHOTO UPLOAD: POST /api/admin/plot/:id/photo  (optional alias: /plots/:id/photo)
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

/* --- Dashboard --- */
router.get("/metrics", allowAdminStaff, adminController.dashboardMetrics);

/* --- Maintenance --- */
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

/* --- Plots --- */
router.post("/add-plot", allowAdminStaff, adminController.addPlots);
router.put("/edit-plot", allowAdminStaff, adminController.editPlots);
router.delete("/delete-plot/:id", allowAdminStaff, adminController.deletePlots);

// ✅ Used by frontend: GET /api/admin/plot/:idOrUid
router.get("/plot/:id", allowAdminStaff, adminController.getPlotDetails);

// ✅ Optional plots list endpoint
router.get("/plots", allowAdminStaff, adminController.getPlots);

// ✅ Used by frontend: POST /api/admin/plot/:id/photo
router.post(
  "/plot/:id/photo",
  allowAdminStaff,
  upload.single("photo"),
  adminController.uploadPlotPhoto
);

// ✅ OPTIONAL ALIAS: POST /api/admin/plots/:id/photo
router.post(
  "/plots/:id/photo",
  allowAdminStaff,
  upload.single("photo"),
  adminController.uploadPlotPhoto
);

/* --- Building Plots --- */
router.post(
  "/add-building-plot",
  allowAdminStaff,
  adminController.addBuildingPlots
);
router.put(
  "/edit-building-plot",
  allowAdminStaff,
  adminController.editBuildingPlots
);
router.delete(
  "/delete-building-plot/:id",
  allowAdminStaff,
  adminController.deleteBuildingPlots
);

/* --- Burial Records (Graves) --- */
router.get(
  "/burial-records",
  allowAdminStaff,
  adminController.getBurialRecords
);
router.post("/burial-records", adminOnly, adminController.addBurialRecord);

// ✅ allow both PATCH styles (your frontend uses PATCH /burial-records)
router.patch("/burial-records", adminOnly, adminController.editBurialRecord);
router.patch("/burial-records/:id", adminOnly, adminController.editBurialRecord);

router.delete(
  "/burial-records/:id",
  adminOnly,
  adminController.deleteBurialRecord
);

/* ✅ OPTIONAL: Keep old endpoints as aliases */
router.get("/graves", allowAdminStaff, adminController.getBurialRecords);
router.post("/graves", adminOnly, adminController.addBurialRecord);
router.post("/edit-burial-record", adminOnly, adminController.editBurialRecord);
router.delete(
  "/delete-burial-record/:id",
  adminOnly,
  adminController.deleteBurialRecord
);

/* --- Users --- */
router.get("/visitor-users", allowAdminStaff, adminController.getVisitorUsers);
router.get("/users/visitors", allowAdminStaff, adminController.getVisitorUsers);

// ✅ Keep these only if your admin.controller.js actually exports these functions.
router.get("/visitors", allowAdminStaff, adminController.getVisitorUsers);
router.post("/visitors", adminOnly, adminController.addVisitorUser);
router.put("/visitors/:id", adminOnly, adminController.updateVisitorUser);
router.delete("/visitors/:id", adminOnly, adminController.deleteVisitorUser);

/* --- Reservations --- */
router.post(
  "/reserve-plot",
  allowAdminStaff,
  adminReservation.reservePlotAsAdmin
);
router.get(
  "/reservations",
  allowAdminStaff,
  adminReservation.getAllReservations
);

router.patch(
  "/cancel-reservation/:id",
  allowAdminStaff,
  adminReservation.cancelReservationAsAdmin
);

router.patch(
  "/reservations/:id/reject",
  allowAdminStaff,
  adminReservation.rejectReservationAsAdmin
);

// ✅ Approve reservation (No payment fields)
router.patch(
  "/reservations/:id/approve",
  allowAdminStaff,
  adminReservation.approveReservationAsAdmin
);

// ✅ Alias for approve-payment
router.patch(
  "/reservations/:id/approve-payment",
  allowAdminStaff,
  adminReservation.approveReservationAsAdmin
);

// ✅ Keep old endpoint as alias
router.patch(
  "/reservations/:id/approve-reservation",
  allowAdminStaff,
  adminReservation.approveReservationAsAdmin
);
/* --- Burial Requests --- */
router.get(
  "/burial-requests",
  allowAdminStaff,
  adminController.getBurialRequestsAsAdmin
);

router.post(
  "/burial-requests/:id/confirm",
  allowAdminStaff,
  adminController.confirmBurialRequestAsAdmin
);

router.put(
  "/burial-requests/:id/confirm",
  allowAdminStaff,
  adminController.confirmBurialRequestAsAdmin
);

// Optional aliases (if your frontend tries these)
router.post(
  "/burial-requests/confirm/:id",
  allowAdminStaff,
  adminController.confirmBurialRequestAsAdmin
);

router.put(
  "/burial-requests/confirm/:id",
  allowAdminStaff,
  adminController.confirmBurialRequestAsAdmin
);

module.exports = router;
