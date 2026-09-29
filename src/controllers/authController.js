const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const generateToken = require('../utils/generateToken');

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateNewUser = ({ fullName, email, phoneNumber, password }) => {
  if (!fullName || !email || !phoneNumber || !password) {
    throw httpError(400, 'fullName, email, phoneNumber and password are required');
  }
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Invalid email address');
  if (String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
};

const sendAuth = (res, status, user) =>
  res.status(status).json({ success: true, token: generateToken(user._id), user });

// @route POST /api/auth/signup   (public, gated by ALLOW_PUBLIC_SIGNUP)
// role/status in the request body are IGNORED: self-signups are always active members.
exports.signup = asyncHandler(async (req, res) => {
  if (process.env.ALLOW_PUBLIC_SIGNUP !== 'true') {
    throw httpError(403, 'Public signup is disabled. Ask an admin to create your account.');
  }
  validateNewUser(req.body);
  const { fullName, email, phoneNumber, password } = req.body;
  const user = await User.create({ fullName, email, phoneNumber, password, role: 'member' });
  sendAuth(res, 201, user);
});

// @route POST /api/auth/login   (public)
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw httpError(400, 'Email and password are required');

  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
  // Same message for unknown email / wrong password to avoid account enumeration.
  if (!user || !(await user.comparePassword(password))) {
    throw httpError(401, 'Invalid email or password');
  }
  if (user.status !== 'active') throw httpError(403, `Account is ${user.status}`);

  sendAuth(res, 200, user);
});

// @route GET /api/auth/me   (private: any authenticated role)
exports.getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user });
});

// @route POST /api/auth/register-member   (admin only)
exports.registerMember = asyncHandler(async (req, res) => {
  validateNewUser(req.body);
  const { fullName, email, phoneNumber, password, role } = req.body;
  const user = await User.create({
    fullName, email, phoneNumber, password,
    role: role === 'admin' ? 'admin' : 'member'
  });
  res.status(201).json({ success: true, user });
});