// backend/routes/burial-records.routes.js
const express = require("express");
const router = express.Router();

const {
  getBurialRecords,
  addBurialRecord,
  editBurialRecord,
  deleteBurialRecord,
} = require("../controllers/burial-records.controller");

// ✅ LIST (admin + visitor)
// GET /api/burial-records
router.get("/", getBurialRecords);

// ✅ OPTIONAL: your controller supports filtering by "family contact" via params
// GET /api/burial-records/:id
router.get("/:id", getBurialRecords);

// ✅ ADMIN ACTIONS
// Your controller already checks req.user.role === "admin" for these,
// so just wire them up here.
router.post("/", addBurialRecord);
router.patch("/", editBurialRecord);
router.delete("/:id", deleteBurialRecord);

module.exports = router;
