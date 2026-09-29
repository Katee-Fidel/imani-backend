const express = require('express');
const ctrl = require('../controllers/transactionController');
const { protect, anyRole, adminOnly, enforceReadOnlyForMembers } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, enforceReadOnlyForMembers);

// READ: master transaction ledger visible to all
router.get('/', anyRole, ctrl.getTransactions);
router.get('/:id', anyRole, ctrl.getTransactionById);

// WRITE: admin only
router.post('/', adminOnly, ctrl.createTransaction);                        // record + allocate a payment
router.put('/:id', adminOnly, ctrl.updateTransaction);                      // method / reference / notes only
router.delete('/payments/:paymentId', adminOnly, ctrl.voidPayment);         // soft void a whole payment
router.delete('/:id', adminOnly, ctrl.voidTransaction);                     // soft void one row

module.exports = router;