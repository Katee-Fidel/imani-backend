const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * protect: verifies the Bearer JWT, loads the user, ensures the account is active,
 * and attaches it to req.user. This alone gives any active, logged-in user access.
 */
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if (!token) throw httpError(401, 'Not authenticated: token missing');

  const decoded = jwt.verify(token, process.env.JWT_SECRET); // JWT errors handled centrally
  const user = await User.findById(decoded.id);
  if (!user) throw httpError(401, 'User no longer exists');
  if (user.status !== 'active') throw httpError(403, `Account is ${user.status}`);

  req.user = user;
  next();
});

/**
 * authorize(...roles): generic RBAC gate. Must run after protect.
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(httpError(401, 'Not authenticated'));
  if (!roles.includes(req.user.role)) {
    return next(httpError(403, `Role '${req.user.role}' is not permitted to perform this action`));
  }
  next();
};

/** Transparent read policy: any active admin or member may read group-wide data. */
const anyRole = authorize('admin', 'member');

/** Write policy: admin only (record payments, allocate funds, disburse loans, settings). */
const adminOnly = authorize('admin');

/**
 * enforceReadOnlyForMembers: defense-in-depth. Mount once per router (after protect):
 *   router.use(protect, enforceReadOnlyForMembers)
 * Members can then only ever make GET/HEAD/OPTIONS requests on that router, even if a
 * developer forgets `adminOnly` on a future write route. Admins are unaffected.
 */
const enforceReadOnlyForMembers = (req, res, next) => {
  if (!req.user) return next(httpError(401, 'Not authenticated'));
  if (req.user.role === 'member' && !READ_METHODS.includes(req.method)) {
    return next(httpError(403, 'Members have read-only access'));
  }
  next();
};

// NOTE: selfOrAdmin was removed. Members may view every member's records.
module.exports = { protect, authorize, anyRole, adminOnly, enforceReadOnlyForMembers };