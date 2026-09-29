const express = require('express');
const ctrl = require('../controllers/userController');
const { protect, anyRole, adminOnly, enforceReadOnlyForMembers } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, enforceReadOnlyForMembers);

// READ: member directory
router.get('/', anyRole, ctrl.getUsers);
router.get('/:id', anyRole, ctrl.getUserById);

// WRITE: admin only (creation stays at POST /api/auth/register-member)
router.put('/:id', adminOnly, ctrl.updateUser);
router.delete('/:id', adminOnly, ctrl.deleteUser);

module.exports = router;