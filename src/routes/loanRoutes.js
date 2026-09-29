const express = require('express');
const ctrl = require('../controllers/loanController');
const { protect, anyRole, adminOnly, enforceReadOnlyForMembers } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, enforceReadOnlyForMembers);

// READ: any admin/member sees the whole group loan book
router.get('/', anyRole, ctrl.getLoans);
router.get('/:id', anyRole, ctrl.getLoanById);

// WRITE: admin only
router.post('/', adminOnly, ctrl.applyForLoan);
router.post('/:id/disburse', adminOnly, ctrl.disburseLoan);
router.post('/:id/reject', adminOnly, ctrl.rejectLoan);
router.put('/:id', adminOnly, ctrl.updateLoan);
router.delete('/:id', adminOnly, ctrl.voidLoan);       // soft void

module.exports = router;