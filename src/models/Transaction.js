const mongoose = require('mongoose');
const softVoid = require('./plugins/softVoid');

const TRANSACTION_TYPES = [
  'shares_savings',
  'loan_repayment',
  'christmas_contrib',
  'retreat_contrib',
  'office_contrib',
  'sitting_allowance',
  'fine_late_loan',
  'fine_late_shares'
];
const PAYMENT_METHODS = ['mpesa', 'bank', 'cash', 'other'];

// Types that must point at a loan (and may not be attached to any other type).
const LOAN_LINKED = ['loan_repayment', 'fine_late_loan'];
// Types that belong to a monthly period ('YYYY-MM').
const PERIOD_REQUIRED = [
  'shares_savings', 'christmas_contrib', 'retreat_contrib',
  'office_contrib', 'sitting_allowance', 'fine_late_shares'
];

// Fields that can never change after creation. Corrections = void + re-enter.
const IMMUTABLE_FIELDS = ['member', 'loan', 'type', 'amount', 'period', 'paymentDate', 'recordedBy', 'paymentId'];

const transactionSchema = new mongoose.Schema(
  {
    member: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    loan: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan' },
    // Groups the rows created by one received payment (one M-Pesa receipt split across categories).
    paymentId: { type: mongoose.Schema.Types.ObjectId, index: true },
    type: { type: String, enum: TRANSACTION_TYPES, required: true },

    // Money received from the member, in KES. Minimums (e.g. Christmas >= 2,000) are enforced in the service layer.
    amount: { type: Number, required: true, min: 0.01, set: (v) => (v == null ? v : Math.round(v * 100) / 100) },

    // Month this payment counts toward, e.g. '2026-09'. Drives the master contribution table.
    period: { type: String, match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be in YYYY-MM format'] },
    paymentDate: { type: Date, default: Date.now },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'mpesa' },
    reference: { type: String, trim: true },   // M-Pesa code / bank slip no.
    notes: { type: String, trim: true, maxlength: 500 },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

transactionSchema.plugin(softVoid);

transactionSchema.pre('validate', function () {
  if (LOAN_LINKED.includes(this.type)) {
    if (!this.loan) this.invalidate('loan', `A loan is required for ${this.type}`);
  } else if (this.loan) {
    this.invalidate('loan', `${this.type} cannot be linked to a loan`);
  }

  if (PERIOD_REQUIRED.includes(this.type) && !this.period) {
    this.invalidate('period', `A period (YYYY-MM) is required for ${this.type}`);
  }

  if (!this.isNew) {
    IMMUTABLE_FIELDS.forEach((f) => {
      if (this.isModified(f)) this.invalidate(f, `${f} cannot be changed; void this transaction and record a new one`);
    });
  }
});

// Block update-style queries from touching immutable fields (voiding fields stay updatable).
transactionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function (next) {
  const u = this.getUpdate() || {};
  const touched = new Set(Object.keys(u));
  ['$set', '$inc', '$unset', '$setOnInsert'].forEach((op) => Object.keys(u[op] || {}).forEach((k) => touched.add(k)));
  const bad = IMMUTABLE_FIELDS.filter((f) => touched.has(f));
  if (bad.length) return next(new Error(`Immutable transaction fields cannot be updated: ${bad.join(', ')}`));
  next();
});

// A payment split across categories shares one reference, so uniqueness covers the whole allocation key.
// Re-submitting the same receipt therefore fails atomically; a voided row frees its key for re-entry.
transactionSchema.index(
  { reference: 1, type: 1, period: 1, loan: 1 },
  { unique: true, partialFilterExpression: { reference: { $type: 'string' }, isVoided: false } }
);
transactionSchema.index({ member: 1, type: 1, period: 1 });
transactionSchema.index({ period: 1, type: 1 });
transactionSchema.index({ loan: 1 });
transactionSchema.index({ paymentDate: -1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
Transaction.TYPES = TRANSACTION_TYPES;
Transaction.PAYMENT_METHODS = PAYMENT_METHODS;
Transaction.LOAN_LINKED = LOAN_LINKED;
Transaction.PERIOD_REQUIRED = PERIOD_REQUIRED;

module.exports = Transaction;