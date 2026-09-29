const Loan = require('../models/Loan');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const loanService = require('../services/loanService');
const { assertObjectId, toObjectId, requireReason, parseDate, parsePagination } = require('../utils/controllerHelpers');

const isAdmin = (req) => req.user.role === 'admin';
const scheduleOf = (loan) => (loan.disbursedDate ? loanService.buildRepaymentSchedule(loan, loan.disbursedDate) : null);

// @route GET /api/loans   (any role: the whole group loan book)
// Filters: status, loanType, member, overdue=true, page, limit. Admins may add includeVoided=true.
exports.getLoans = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (!(isAdmin(req) && q.includeVoided === 'true')) filter.isVoided = false;
  if (q.status) {
    if (!Loan.LOAN_STATUSES.includes(q.status)) throw httpError(400, `status must be one of: ${Loan.LOAN_STATUSES.join(', ')}`);
    filter.status = q.status;
  }
  if (q.loanType) {
    if (!Loan.LOAN_TYPES.includes(q.loanType)) throw httpError(400, `loanType must be one of: ${Loan.LOAN_TYPES.join(', ')}`);
    filter.loanType = q.loanType;
  }
  if (q.member) filter.member = toObjectId(q.member, 'member');
  if (q.overdue === 'true') { filter.status = 'active'; filter.dueDate = { $lt: new Date() }; }

  const { page, limit, skip } = parsePagination(q);
  const [loans, total, agg] = await Promise.all([
    Loan.find(filter).populate('member', 'fullName status').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Loan.countDocuments(filter),
    Loan.aggregate([
      { $match: filter },
      { $group: { _id: null, principal: { $sum: '$principal' }, totalPayable: { $sum: '$totalPayable' }, amountPaid: { $sum: '$amountPaid' } } }
    ])
  ]);

  const t = agg[0] || { principal: 0, totalPayable: 0, amountPaid: 0 };
  res.json({
    success: true, count: loans.length, total, page, pages: Math.ceil(total / limit) || 1,
    totals: {
      principal: Math.round(t.principal * 100) / 100,
      totalPayable: Math.round(t.totalPayable * 100) / 100,
      amountPaid: Math.round(t.amountPaid * 100) / 100,
      outstanding: Math.round((t.totalPayable - t.amountPaid) * 100) / 100
    },
    loans
  });
});

// @route GET /api/loans/:id   (any role)
exports.getLoanById = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'loan id');
  const loan = await Loan.findById(req.params.id).populate('member', 'fullName status');
  if (!loan || (loan.isVoided && !isAdmin(req))) throw httpError(404, 'Loan not found');

  const repayments = await Transaction.find({ loan: loan._id, isVoided: false })
    .sort({ paymentDate: 1 }).select('type amount paymentDate paymentMethod reference paymentId');

  res.json({ success: true, loan, repayments, schedule: scheduleOf(loan) });
});

// @route POST /api/loans   (admin) - capture a loan application (status: pending)
exports.applyForLoan = asyncHandler(async (req, res) => {
  const { member, loanType, principal, notes, applicationDate } = req.body;
  assertObjectId(member, 'member');

  const user = await User.findById(member).select('status');
  if (!user) throw httpError(404, 'Member not found');
  if (user.status !== 'active') throw httpError(409, 'Only active members can apply for loans');

  const terms = loanService.computeLoanTerms({ loanType, principal });
  const loan = await Loan.create({
    ...terms, member, notes,
    applicationDate: parseDate(applicationDate, 'applicationDate'),
    createdBy: req.user._id
  });
  res.status(201).json({ success: true, loan });
});

// @route POST /api/loans/:id/disburse   (admin) - pending -> active, sets disbursedDate + dueDate
exports.disburseLoan = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'loan id');
  const loan = await Loan.findById(req.params.id);
  if (!loan) throw httpError(404, 'Loan not found');

  const disbursedDate = parseDate(req.body.disbursedDate, 'disbursedDate') || new Date();
  loanService.markDisbursed(loan, { disbursedBy: req.user._id, disbursedDate });
  await loan.save(); // optimistic concurrency: a concurrent double-disburse fails with 409
  res.json({ success: true, loan, schedule: scheduleOf(loan) });
});

// @route POST /api/loans/:id/reject   (admin) - pending -> rejected
exports.rejectLoan = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'loan id');
  const reason = requireReason(req.body.reason);
  const loan = await Loan.findById(req.params.id);
  if (!loan) throw httpError(404, 'Loan not found');
  if (loan.isVoided) throw httpError(409, 'Loan is voided');
  if (loan.status !== 'pending') throw httpError(409, `Only pending loans can be rejected (status: ${loan.status})`);

  loan.status = 'rejected';
  loan.notes = [loan.notes, `Rejected: ${reason}`].filter(Boolean).join(' | ');
  await loan.save();
  res.json({ success: true, loan });
});

// @route PUT /api/loans/:id   (admin)
// Pending loans: loanType, principal (terms are recomputed), applicationDate, notes. Others: notes only.
exports.updateLoan = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'loan id');
  const loan = await Loan.findById(req.params.id);
  if (!loan) throw httpError(404, 'Loan not found');
  if (loan.isVoided) throw httpError(409, 'Cannot edit a voided loan');

  const { loanType, principal, notes, applicationDate } = req.body;
  let changed = false;

  if (loanType !== undefined || principal !== undefined) {
    if (loan.status !== 'pending') throw httpError(409, 'Loan terms can only be changed while the loan is pending');
    loan.set(loanService.computeLoanTerms({ loanType: loanType ?? loan.loanType, principal: principal ?? loan.principal }));
    changed = true;
  }
  if (applicationDate !== undefined) {
    if (loan.status !== 'pending') throw httpError(409, 'applicationDate can only be changed while the loan is pending');
    loan.applicationDate = parseDate(applicationDate, 'applicationDate');
    changed = true;
  }
  if (notes !== undefined) { loan.notes = notes; changed = true; }
  if (!changed) throw httpError(400, 'Provide at least one of: loanType, principal, applicationDate, notes');

  await loan.save();
  res.json({ success: true, loan });
});

// @route DELETE /api/loans/:id   (admin) - SOFT void; body/query { reason }
exports.voidLoan = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'loan id');
  const reason = requireReason((req.body && req.body.reason) ?? req.query.reason);
  const loan = await Loan.findById(req.params.id);
  if (!loan) throw httpError(404, 'Loan not found');
  if (loan.isVoided) throw httpError(409, 'Loan is already voided');

  const linked = await Transaction.countDocuments({ loan: loan._id, isVoided: false });
  if (linked) throw httpError(409, `Void the ${linked} linked transaction(s) first`);

  loan.voidRecord(req.user._id, reason);
  await loan.save();
  res.json({ success: true, message: 'Loan voided; the record is preserved for audit', loan });
});