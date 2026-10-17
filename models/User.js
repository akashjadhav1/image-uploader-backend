const mongoose = require("mongoose");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const BCRYPT_ROUNDS = 10;

// Legacy hashing (Node built-in scrypt), kept only so accounts created before
// the bcrypt migration can still log in. Stored as "salt:hash".
function verifyPasswordScrypt(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

// Current hashing: bcrypt (self-salted, format "$2b$<rounds>...")
function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

// bcrypt hashes start with "$2a$", "$2b$" or "$2y$"; anything else is a legacy scrypt value
function isBcryptHash(stored) {
  return /^\$2[aby]\$/.test(String(stored || ""));
}

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    // Login identifier — unique when present (sparse keeps legacy users without email valid)
    email: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      select: false, // never return the hash by default
    },
    // Optional profile — can be sent at login to create/update user record
    profile: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      image: { type: String, trim: true }, // public URL like /uploads/xxx.jpg
    },
  },
  { timestamps: true }
);

// Hash password before saving (skips if already a bcrypt hash to avoid double-hashing)
userSchema.pre("save", async function () {
  if (this.isModified("password") && !isBcryptHash(this.password)) {
    this.password = hashPassword(this.password);
  }
});

// Verify against whichever format is stored (bcrypt, or legacy scrypt)
userSchema.methods.comparePassword = async function (password) {
  if (isBcryptHash(this.password)) {
    return bcrypt.compare(password, this.password);
  }
  return verifyPasswordScrypt(password, this.password);
};

// True while the stored hash is still the old scrypt format
userSchema.methods.needsRehash = function () {
  return !isBcryptHash(this.password);
};

// Upgrade a legacy scrypt account to bcrypt after a successful login.
// Assigning the plain password lets the pre-save hook hash it with bcrypt.
userSchema.methods.upgradePassword = async function (plainPassword) {
  this.password = plainPassword;
  this.markModified("password");
  await this.save();
};

// Simple HMAC-signed token (payload.signature), valid for 7 days
userSchema.methods.generateToken = function () {
  const secret = process.env.JWT_SECRET || "dev-secret-change-me";
  const payload = Buffer.from(
    JSON.stringify({
      id: this._id.toString(),
      username: this.username,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

// Verify an HMAC token produced by generateToken. Returns the payload
// ({ id, username, exp }) or null when missing, tampered, or expired.
userSchema.statics.verifyToken = function (token) {
  const secret = process.env.JWT_SECRET || "dev-secret-change-me";
  if (!token || typeof token !== "string") return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
};

module.exports = mongoose.model("User", userSchema);
