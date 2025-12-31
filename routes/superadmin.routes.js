const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { addUser, users, updateUser, deleteUser, saveCemeteryInfo } = require('../controllers/superadmin.controller');
const { verifyToken } = require('../middleware/auth');

// Minimal multer setup (adjust storage/dest to your project)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(process.cwd(), 'uploads', 'logos')),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext).replace(/\s+/g, '_');
      cb(null, `${base}-${Date.now()}${ext}`);
    },
  });
  const upload = multer({ storage });

router.post('/add-user', verifyToken, addUser);
router.get('/users', verifyToken, users);
router.put('/update-user/:id', verifyToken, updateUser);
router.delete('/delete-user/:id', verifyToken, deleteUser);

// PUT save/upssert (logo optional)
router.put('/save-cemetery-info', upload.single('logo'), verifyToken, saveCemeteryInfo);

module.exports = router;
