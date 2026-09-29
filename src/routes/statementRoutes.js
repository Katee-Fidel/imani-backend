const express = require('express');
const ctrl = require('../controllers/statementController');
const { protect, anyRole, enforceReadOnlyForMembers } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, enforceReadOnlyForMembers);

// Read-only for everyone; no selfOrAdmin scoping (global transparency).
router.get('/', anyRole, ctrl.getMasterContributionTable);   // master contribution table (?format=pdf)
router.get('/summary', anyRole, ctrl.getGroupSummary);       // must stay above '/:userId'
router.get('/:userId', anyRole, ctrl.getMemberStatement);    // any member's statement
router.get('/:userId/pdf', anyRole, ctrl.downloadStatementPdf);

module.exports = router;