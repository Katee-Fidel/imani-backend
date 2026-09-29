const express = require('express');
const rateLimit = require('express-rate-limit');
const { signup, login, getProfile, registerMember } = require('../controllers/authController');
const { protect, adminOnly, anyRole } = require('../middleware/authMiddleware');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, try again in 15 minutes' }
});

router.post('/signup', authLimiter, signup);
router.post('/login', authLimiter, login);
router.get('/me', protect, anyRole, getProfile);
router.post('/register-member', protect, adminOnly, registerMember);

module.exports = router;