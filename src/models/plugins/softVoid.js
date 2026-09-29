const mongoose = require('mongoose');

/**
 * softVoid plugin: audit-safe "deletion" for financial records.
 *  - Adds isVoided / voidedAt / voidedBy / voidReason
 *  - doc.voidRecord(userId, reason) marks a record void (caller saves, optionally with a session)
 *  - Query helper: Model.find().notVoided()
 *  - Blocks hard deletes made through Mongoose (deleteOne, deleteMany, findOneAndDelete)
 * Note: raw driver calls (Model.collection.*, bulkWrite) bypass Mongoose hooks, so don't use them for deletes.
 */
module.exports = function softVoid(schema) {
  schema.add({
    isVoided: { type: Boolean, default: false, index: true },
    voidedAt: { type: Date },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    voidReason: { type: String, trim: true, maxlength: 500 }
  });

  schema.pre('validate', function () {
    if (this.isVoided) {
      if (!this.voidReason) this.invalidate('voidReason', 'A reason is required when voiding a record');
      if (!this.voidedBy) this.invalidate('voidedBy', 'voidedBy is required when voiding a record');
    }
  });

  schema.methods.voidRecord = function (userId, reason) {
    if (this.isVoided) throw new Error('Record is already voided');
    this.isVoided = true;
    this.voidedAt = new Date();
    this.voidedBy = userId;
    this.voidReason = reason;
    return this;
  };

  schema.query.notVoided = function () {
    return this.where({ isVoided: false });
  };

  const blockHardDelete = function (next) {
    next(new Error('Hard deletes are disabled for financial records; void the record instead'));
  };
  schema.pre('deleteOne', { document: true, query: true }, blockHardDelete);
  schema.pre('deleteMany', blockHardDelete);
  schema.pre('findOneAndDelete', blockHardDelete);
};