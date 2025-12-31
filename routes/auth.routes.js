const router = require('express').Router();
const {
  login,
  register,
  logout,
  me,
  updateProfile,
  changePassword,
} = require('../controllers/auth.controller');
const { verifyToken, requireRole } = require('../middleware/auth');

router.post('/login', login);
router.post('/register', register);

router.post('/logout', verifyToken, logout);
router.get('/me', verifyToken, me);
router.patch('/update-profile', verifyToken, updateProfile);
router.post('/change-password', verifyToken, changePassword);

router.post('/admin/register', verifyToken, requireRole('admin'), register);

module.exports = router;
