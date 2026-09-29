const notFound = (req, res, next) => {
  const err = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  err.statusCode = 404;
  next(err);
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let status = err.statusCode || 500;
  let message = err.message || 'Server error';

  if (err.name === 'JsonWebTokenError') { status = 401; message = 'Invalid token'; }
  else if (err.name === 'TokenExpiredError') { status = 401; message = 'Token expired, please log in again'; }
  else if (err.code === 11000) {
    status = 409;
    message = `${Object.keys(err.keyValue || {})[0] || 'Field'} already exists`;
  } else if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join(', ');
  } else if (err.name === 'CastError') { status = 400; message = 'Invalid ID format'; }
  else if (err.name === 'VersionError') { status = 409; message = 'This record was changed by someone else. Reload and retry.'; }

  if (status === 500 && process.env.NODE_ENV === 'production') message = 'Server error';

  res.status(status).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== 'production' && status === 500 ? { stack: err.stack } : {})
  });
};

module.exports = { notFound, errorHandler };