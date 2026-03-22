const express    = require("express");
const router     = express.Router();
const User       = require("../models/User");
const bcrypt     = require("bcryptjs");
const crypto     = require("crypto");
const axios      = require("axios");
const otpStore   = require("../utils/otpStore");

// ── Brevo API helper ──────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const response = await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender:      { name: "ClearWave AI", email: "clearwave48@gmail.com" },
      to:          [{ email: to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        "api-key":      process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
}

// ── Password rule ─────────────────────────────────────────────────────
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

// ── Rate limiter: max 3 OTPs per email per hour ───────────────────────
const otpRateLimit = new Map();
const checkOtpRateLimit = (email) => {
  const now    = Date.now();
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
    console.log(`[OTP DEBUG] Generated OTP for ${email}: ${otp}`);

    await sendEmail({
      to: email,
      subject: "ClearWave AI — OTP Verification",
      html: `
        <div style="max-width:520px;margin:0 auto;font-family:Arial;border:1px solid #eee;border-radius:12px;overflow:hidden;">
          <div style="background:#0a0a0a;padding:28px 32px;text-align:center;">
            <p style="color:#fff;font-size:22px;font-weight:600;margin:0;">ClearWave AI</p>
            <p style="color:rgba(255,255,255,0.5);font-size:13px;margin:4px 0 0;">Audio Intelligence Platform</p>
          </div>
          <div style="padding:32px;">
            <p style="font-size:15px;color:#111;margin:0 0 8px;">Hi <strong>${name}</strong>,</p>
            <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 28px;">
              Welcome to ClearWave AI! Use the verification code below to complete your signup. This code is valid for <strong style="color:#111;">5 minutes</strong>.
            </p>
            <div style="background:#f5f5f5;border-radius:10px;padding:24px;text-align:center;margin-bottom:28px;border:1px solid #eee;">
              <p style="font-size:12px;color:#888;margin:0 0 10px;letter-spacing:1px;text-transform:uppercase;">Your verification code</p>
              <p style="font-size:40px;font-weight:600;letter-spacing:14px;margin:0;color:#111;font-family:monospace;">${otp}</p>
            </div>
            <p style="font-size:13px;color:#555;margin:0 0 10px;line-height:1.6;">&#9888; Never share this code. ClearWave AI will never ask for your OTP via phone or chat.</p>
            <p style="font-size:13px;color:#555;margin:0;line-height:1.6;">&#128274; If you didn't create an account, you can safely ignore this email.</p>
          </div>
          <div style="border-top:1px solid #eee;padding:20px 32px;text-align:center;">
            <p style="font-size:12px;color:#aaa;margin:0;">&copy; 2026 ClearWave AI &nbsp;&middot;&nbsp; Automated message, please do not reply.</p>
          </div>
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
    console.error("SEND OTP ERROR:", err?.response?.data || err.message);
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
    user.resetToken       = token;
    user.resetTokenExpiry = Date.now() + 15 * 60 * 1000;
    await user.save();

    const resetLink = `${process.env.BASE_URL}/reset-password/${token}`;

    await sendEmail({
      to: email,
      subject: "Reset your ClearWave AI password",
      html: `
        <div style="max-width:520px;margin:0 auto;font-family:Arial;border:1px solid #eee;border-radius:12px;overflow:hidden;">
          <div style="background:#0a0a0a;padding:28px 32px;text-align:center;">
            <p style="color:#fff;font-size:22px;font-weight:600;margin:0;">ClearWave AI</p>
            <p style="color:rgba(255,255,255,0.5);font-size:13px;margin:4px 0 0;">Audio Intelligence Platform</p>
          </div>
          <div style="padding:32px;">
            <p style="font-size:15px;color:#111;margin:0 0 8px;">Hi <strong>${user.name}</strong>,</p>
            <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 28px;">
              We received a request to reset your ClearWave AI password. Click the button below to set a new password. This link expires in <strong style="color:#111;">15 minutes</strong>.
            </p>
            <div style="text-align:center;margin-bottom:28px;">
              <a href="${resetLink}"
                 style="display:inline-block;padding:14px 32px;background:#0a0a0a;color:#fff;
                 text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">
                Reset Password
              </a>
            </div>
            <p style="font-size:13px;color:#555;margin:0 0 10px;line-height:1.6;">&#9888; This link will expire in 15 minutes for your security.</p>
            <p style="font-size:13px;color:#555;margin:0;line-height:1.6;">&#128274; If you didn't request a password reset, please ignore this email. Your account is safe.</p>
          </div>
          <div style="border-top:1px solid #eee;padding:20px 32px;text-align:center;">
            <p style="font-size:12px;color:#aaa;margin:0;">&copy; 2026 ClearWave AI &nbsp;&middot;&nbsp; Automated message, please do not reply.</p>
          </div>
        </div>
      `,
    });

    res.json({ message: "Reset link sent to email" });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err?.response?.data || err.message);
    res.status(500).json({ message: "Failed to send reset email" });
  }
});

// ══════════════════════════════════════════════════════════════════════
// VERIFY RESET TOKEN
// ══════════════════════════════════════════════════════════════════════
router.get("/verify-reset-token/:token", async (req, res) => {
  const user = await User.findOne({
    resetToken:       req.params.token,
    resetTokenExpiry: { $gt: Date.now() },
  });
  if (!user)
    return res.status(400).json({ message: "Invalid or expired reset link" });
  res.json({ message: "Token valid" });
});

// ══════════════════════════════════════════════════════════════════════
// RESET PASSWORD
// ══════════════════════════════════════════════════════════════════════
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { password } = req.body;
    if (!passwordRegex.test(password))
      return res.status(400).json({ message: "Weak password. Must have uppercase, lowercase, number & special character." });

    const user = await User.findOne({
      resetToken:       req.params.token,
      resetTokenExpiry: { $gt: Date.now() },
    });
    if (!user)
      return res.status(400).json({ message: "Invalid or expired link" });

    user.password         = await bcrypt.hash(password, 10);
    user.resetToken       = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ message: "Password reset successful. You can now login." });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ message: "Reset failed" });
  }
});

module.exports = router;