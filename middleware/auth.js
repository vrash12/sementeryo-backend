//backend/middleware/auth.js
const jwt = require("jsonwebtoken");

function verifyToken(req, res, next) {
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: "Server JWT_SECRET is not configured" });
  }

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    // clearer message
    if (e?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(...rolesInput) {
  const allowedRoles = rolesInput
    .flat()
    .filter(Boolean)
    .map((r) => String(r).toLowerCase());

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const userRole = String(req.user.role || "").toLowerCase();
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    return next();
  };
}

module.exports = { verifyToken, requireRole };
