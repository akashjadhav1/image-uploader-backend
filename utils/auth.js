const User = require("../models/User");

// Read the token from the Authorization header ("Bearer <token>") or "x-token".
function extractToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (req.headers["x-token"]) return String(req.headers["x-token"]).trim();
  return null;
}

// Require a valid token; attaches { userId, username } to req or returns 401.
function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Missing authentication token. Send 'Authorization: Bearer <token>'.",
    });
  }

  const payload = User.verifyToken(token);
  if (!payload) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }

  req.userId = payload.id;
  req.authUser = { id: payload.id, username: payload.username };
  return next();
}

module.exports = { authenticate, extractToken };
