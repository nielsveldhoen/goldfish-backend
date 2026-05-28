import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = {
      id: decoded.userId
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}