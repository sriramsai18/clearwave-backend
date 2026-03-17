const express       = require("express");
const router        = express.Router();
const User          = require("../models/User");
const nodemailer    = require("nodemailer");
const bcrypt        = require("bcryptjs");
const crypto        = require("crypto");
const otpStore      = require("../utils/otpStore"); // Fix #2: use shared Map, not local {}

// ── Fix #1: transporter defined FIRST before any route uses it ────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ── Debug: verify email config on startup ────────────────────────────
transporter.verify((err) => {
  if (err) {
    console.error("❌ Email config error:", err.message);
    console.error("   EMAIL_USER :", process.env.EMAIL_USER);
    console.error("   EMAIL_PASS length:", process.env.EMAIL_PASS?.length, "(should be 16)");
  } else {
    console.log("✅ Email transporter ready — Gmail connected");
  }
});

// ── Password rule ─────────────────────────────────────────────────────
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

// ── Fix #9: Simple in-memory rate limiter for OTP (max 3 per email/hour)
const otpRateLimit = new Map();
const checkOtpRateLimit = (email) => {
  const now = Date.now();
  const record = otpRateLimit.get(email);
  if (!record || now > record.resetAt) {
    otpRateLimit.set(email, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (record.count >= 3) return false;
  record.count++;
  return true;
};

// ══════════════════════════════════════════════════════════════════════
// SIGNUP — Step 1: Send OTP
// ══════════════════════════════════════════════════════════════════════
router.post("/send-otp", async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email)
      return res.status(400).json({ message: "Name and Email required" });
    if (!email.endsWith("@gmail.com"))
      return res.status(400).json({ message: "Only Gmail allowed" });
    if (await User.findOne({ email }))
      return res.status(400).json({ message: "Account already exists" });
    if (!checkOtpRateLimit(email))
      return res.status(429).json({ message: "Too many OTP requests. Try again in an hour." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`[OTP DEBUG] Generated OTP for ${email}: ${otp}`); // remove after testing

    await transporter.sendMail({
      from: `ClearWave AI <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "ClearWave AI — OTP Verification",
      html: `
        <div style="font-family:Arial;max-width:400px">
          <h3>Your OTP Code</h3>
          <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${otp}</p>
          <p style="color:#555">Valid for <strong>5 minutes</strong>. Do not share this code.</p>
        </div>
      `,
    });

    console.log(`[OTP DEBUG] Email sent successfully to ${email}`);

    otpStore.set(email, {
      otp,
      name,
      expiresAt: Date.now() + 5 * 60 * 1000,
      verified: false,
    });

    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error("SEND OTP ERROR:", err);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

// ══════════════════════════════════════════════════════════════════════
// SIGNUP — Step 2: Verify OTP
// ══════════════════════════════════════════════════════════════════════
router.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  const record = otpStore.get(email);
  if (!record)
    return res.status(400).json({ message: "OTP not found. Please request a new one." });
  if (record.expiresAt < Date.now())
    return res.status(400).json({ message: "OTP expired. Please request a new one." });
  if (record.otp !== otp)
    return res.status(400).json({ message: "Invalid OTP" });
  record.verified = true;
  res.json({ message: "OTP verified" });
});

// ══════════════════════════════════════════════════════════════════════
// SIGNUP — Step 3: Complete Signup
// ══════════════════════════════════════════════════════════════════════
router.post("/complete-signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!otpStore.get(email)?.verified)
    return res.status(400).json({ message: "Email not verified" });
  if (!passwordRegex.test(password))
    return res.status(400).json({ message: "Weak password. Must have uppercase, lowercase, number & special character." });

  const hash = await bcrypt.hash(password, 10);
  await User.create({ name, email, password: hash });
  otpStore.delete(email);
  res.json({ message: "Account created successfully" });
});

// ══════════════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════════════
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).json({ message: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(400).json({ message: "Invalid credentials" });
    res.json({
      message: "Login success",
      user: { _id: user._id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

// ══════════════════════════════════════════════════════════════════════
// FORGOT PASSWORD
// ══════════════════════════════════════════════════════════════════════
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).json({ message: "Email not registered" });

    const token = crypto.randomBytes(32).toString("hex");
    user.resetToken = token;
    user.resetTokenExpiry = Date.now() + 15 * 60 * 1000;
    await user.save();

    // Fix #3: link points to React frontend, not backend route
    const resetLink = `${process.env.BASE_URL}/reset-password/${token}`;

    await transporter.sendMail({
      from: `ClearWave AI <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Reset your ClearWave AI password",
      html: `
        <div style="font-family:Arial;max-width:480px">
          <h3>Password Reset Request</h3>
          <p>Click the button below to reset your password. This link expires in <strong>15 minutes</strong>.</p>
          <a href="${resetLink}"
             style="padding:12px 22px;background:#000;color:#fff;
             text-decoration:none;border-radius:6px;display:inline-block;margin:12px 0">
             Reset Password
          </a>
          <p style="font-size:12px;color:#555;margin-top:14px">
            If you did not request this, please ignore this email.
          </p>
        </div>
      `,
    });

    res.json({ message: "Reset link sent to email" });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ message: "Failed to send reset email" });
  }
});

// ══════════════════════════════════════════════════════════════════════
// VERIFY RESET TOKEN — Fix #3: GET only verifies, no HTML served
// React frontend handles the page at /reset-password/:token
// ══════════════════════════════════════════════════════════════════════
router.get("/verify-reset-token/:token", async (req, res) => {
  const user = await User.findOne({
    resetToken: req.params.token,
    resetTokenExpiry: { $gt: Date.now() },
  });
  if (!user)
    return res.status(400).json({ message: "Invalid or expired reset link" });
  res.json({ message: "Token valid" });
});

// ══════════════════════════════════════════════════════════════════════
// RESET PASSWORD POST
// ══════════════════════════════════════════════════════════════════════
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { password } = req.body;
    if (!passwordRegex.test(password))
      return res.status(400).json({ message: "Weak password. Must have uppercase, lowercase, number & special character." });

    const user = await User.findOne({
      resetToken: req.params.token,
      resetTokenExpiry: { $gt: Date.now() },
    });
    if (!user)
      return res.status(400).json({ message: "Invalid or expired link" });

    user.password = await bcrypt.hash(password, 10);
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ message: "Password reset successful. You can now login." });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ message: "Reset failed" });
  }
});

module.exports = router;