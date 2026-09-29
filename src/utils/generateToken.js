const jwt = require('jsonwebtoken');

// Only the user id goes in the token; role/status are re-read from the DB on every request
// so demotions and suspensions take effect immediately.
module.exports = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });