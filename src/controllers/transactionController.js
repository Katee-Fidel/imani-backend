const Transaction = require('../models/Transaction');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');
const paymentService = require('../services/paymentService');
const { assertObjectId, toObjectId, requireReason, parseDate, parsePagination } = require('../utils/controllerHelpers');

const isAdmin = (req) => req.user.role === 'admin';
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// @route GET /api/transactions   (any role: the master ledger)
// Filters: member, loan, paymentId, type, period, from, to (exclusive), page, limit. Admins: includeVoided=true.
exports.getTransactions = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (!(isAdmin(req) && q.includeVoided === 'true')) filter.isVoided = false;
  if (q.member) filter.member = toObjectId(q.member, 'member');
  if (q.loan) filter.loan = toObjectId(q.loan, 'loan');
  if (q.paymentId) filter.paymentId = toObjectId(q.paymentId, 'paymentId');
  if (q.type) {
    if (!Transaction.TYPES.includes(q.type)) throw httpError(400, `type must be one of: ${Transaction.TYPES.join(', ')}`);
    filter.type = q.type;
  }
  if (q.period) {
    if (!PERIOD_RE.test(String(q.period))) throw httpError(400, 'period must be in YYYY-MM format');
    filter.period = String(q.period);
  }
  const from = parseDate(q.from, 'from');
  const to = parseDate(q.to, 'to');
  if (from || to) filter.paymentDate = { ...(from && { $gte: from }), ...(to && { $lt: to }) };

  const { page, limit, skip } = parsePagination(q);
  const [transactions, total, agg] = await Promise.all([
    Transaction.find(filter).populate('member', 'fullName').populate('recordedBy', 'fullName')
      .sort({ paymentDate: -1, createdAt: -1 }).skip(skip).limit(limit),
    Transaction.countDocuments(filter),
    Transaction.aggregate([{ $match: { ...filter, isVoided: false } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
  ]);

  res.json({
    success: true, count: transactions.length, total, page, pages: Math.ceil(total / limit) || 1,
    totalAmount: agg[0] ? Math.round(agg[0].total * 100) / 100 : 0,
    transactions
  });
});

// @route GET /api/transactions/:id   (any role)
exports.getTransactionById = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'transaction id');
  const tx = await Transaction.findById(req.params.id)
    .populate('member', 'fullName').populate('recordedBy', 'fullName').populate('loan', 'loanType principal status');
  if (!tx || (tx.isVoided && !isAdmin(req))) throw httpError(404, 'Transaction not found');
  res.json({ success: true, transaction: tx });
});

// @route POST /api/transactions   (admin) - record a payment and allocate it
// Split payment:  { member, paymentDate?, paymentMethod?, reference?, period?, notes?, allocations: [{ type, amount, period?, loan? }] }
// Single payment: { member, type, amount, period?, loan?, ... }
exports.createTransaction = asyncHandler(async (req, res) => {
  const body = req.body || {};
  let allocations = body.allocations;
  if (allocations === undefined && body.type !== undefined) {
    allocations = [{ type: body.type, amount: body.amount, period: body.period, loan: body.loan }];
  }
  const payment = await paymentService.recordPayment({ ...body, allocations }, req.user);
  res.status(201).json({ success: true, payment });
});

// @route PUT /api/transactions/:id   (admin) - only non-financial fields; amounts/types are immutable
exports.updateTransaction = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'transaction id');
  const tx = await Transaction.findById(req.params.id);
  if (!tx) throw httpError(404, 'Transaction not found');
  if (tx.isVoided) throw httpError(409, 'Cannot edit a voided transaction');

  const editable = ['paymentMethod', 'reference', 'notes'];
  const updates = {};
  editable.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) {
    throw httpError(400, `Only ${editable.join(', ')} can be edited. To correct an amount, type, member or period, void this transaction and record a new one.`);
  }
  tx.set(updates);
  await tx.save();
  res.json({ success: true, transaction: tx });
});

// @route DELETE /api/transactions/:id   (admin) - SOFT void one row; body/query { reason }
exports.voidTransaction = asyncHandler(async (req, res) => {
  assertObjectId(req.params.id, 'transaction id');
  const reason = requireReason((req.body && req.body.reason) ?? req.query.reason);
  const result = await paymentService.voidTransactions({ _id: req.params.id }, reason, req.user);
  res.json({ success: true, message: 'Transaction voided; the record is preserved for audit', ...result });
});

// @route DELETE /api/transactions/payments/:paymentId   (admin) - SOFT void every row of one payment
exports.voidPayment = asyncHandler(async (req, res) => {
  const paymentId = assertObjectId(req.params.paymentId, 'payment id');
  const reason = requireReason((req.body && req.body.reason) ?? req.query.reason);
  const result = await paymentService.voidTransactions({ paymentId }, reason, req.user);
  res.json({ success: true, message: 'Payment voided; the records are preserved for audit', ...result });
});