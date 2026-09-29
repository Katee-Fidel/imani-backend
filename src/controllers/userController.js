const mongoose = require('mongoose');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const httpError = require('../utils/httpError');

// Members see a projected directory (no email / phone); admins see full metadata.
// The password hash is never returned (select: false on the schema).
const MEMBER_VIEW = 'fullName role status joinedDate';
const ADMIN_VIEW = '-__v';
const viewFor = (user) => (user.role === 'admin' ? ADMIN_VIEW : MEMBER_VIEW);

const EDITABLE_FIELDS = ['fullName', 'email', 'phoneNumber', 'role', 'status'];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertValidId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw httpError(400, 'Invalid user id');
};

// Never let the group end up with no active admin.
async function assertAnotherActiveAdminExists(excludeId) {
  const others = await User.countDocuments({ role: 'admin', status: 'active', _id: { $ne: excludeId } });
  if (others === 0) throw httpError(409, 'At least one active admin must remain');
}

const isActiveAdmin = (u) => u.role === 'admin' && u.status === 'active';

// @route GET /api/users?search=&status=&page=&limit=   (any authenticated role)
exports.getUsers = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) {
    if (!User.schema.path('status').enumValues.includes(req.query.status)) throw httpError(400, 'Invalid status filter');
    filter.status = req.query.status;
  }
  if (req.query.search) {
    filter.fullName = { $regex: escapeRegex(String(req.query.search).slice(0, 60)), $options: 'i' };
  }

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  const [users, total] = await Promise.all([
    User.find(filter).select(viewFor(req.user)).sort({ fullName: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter)
  ]);

  res.json({ success: true, count: users.length, total, page, pages: Math.ceil(total / limit) || 1, users });
});

// @route GET /api/users/:id   (any authenticated role)
exports.getUserById = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  const user = await User.findById(req.params.id).select(viewFor(req.user)).lean();
  if (!user) throw httpError(404, 'User not found');
  res.json({ success: true, user });
});

// @route PUT /api/users/:id   (admin only)
// Editable: fullName, email, phoneNumber, role, status. Passwords are not changed here.
exports.updateUser = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  const user = await User.findById(req.params.id);
  if (!user) throw httpError(404, 'User not found');

  const updates = {};
  EDITABLE_FIELDS.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) throw httpError(400, `Provide at least one of: ${EDITABLE_FIELDS.join(', ')}`);

  const losesAdminAccess =
    isActiveAdmin(user) &&
    ((updates.role !== undefined && updates.role !== 'admin') || (updates.status !== undefined && updates.status !== 'active'));

  if (losesAdminAccess) {
    if (String(user._id) === String(req.user._id)) throw httpError(409, 'You cannot demote or deactivate your own account');
    await assertAnotherActiveAdminExists(user._id);
  }

  user.set(updates);
  await user.save(); // enum / unique-email errors surface via errorMiddleware
  res.json({ success: true, user });
});

// @route DELETE /api/users/:id   (admin only)
// Soft removal: members are referenced by loans and transactions, so the account is
// set to 'inactive' rather than deleted. History stays intact and the login is blocked.
exports.deleteUser = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  const user = await User.findById(req.params.id);
  if (!user) throw httpError(404, 'User not found');
  if (String(user._id) === String(req.user._id)) throw httpError(409, 'You cannot deactivate your own account');
  if (user.status === 'inactive') throw httpError(409, 'User is already inactive');
  if (isActiveAdmin(user)) await assertAnotherActiveAdminExists(user._id);

  user.status = 'inactive';
  await user.save();
  res.json({ success: true, message: 'Member deactivated; financial records are preserved', user });
});