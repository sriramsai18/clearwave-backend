require("dotenv").config();
const express    = require("express");
const mongoose   = require("mongoose");
const cors       = require("cors");
const multer     = require("multer");
const fs         = require("fs");
const axios      = require("axios");
const fetch      = require("node-fetch");

const authRoutes = require("./routes/auth");
const Audio      = require("./models/Audio");
const cloudinary = require("./cloudinary");

const app = express();

// ── CORS ───────────────────────────────────────────────────────────
const allowedOrigins = [
  "https://clearwaveai.in",
  "https://www.clearwaveai.in",
  "https://clearwav.vercel.app",
  "http://localhost:3000",
  // Extra: also allow any FRONTEND_URL set in Render env vars
  process.env.FRONTEND_URL,
].filter(Boolean).map(o => o.replace(/\/$/, "")); // strip trailing slashes

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Normalize origin — strip trailing slash before comparing
    const normalized = origin.replace(/\/$/, "");
    if (allowedOrigins.includes(normalized)) return callback(null, true);
    console.error(`CORS blocked: ${origin}`);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Pre-flight OPTIONS requests must be answered before any other middleware
app.options(/.*/, cors());

app.use(express.json());

// ── MULTER ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({});
const upload  = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) return cb(null, true);
    cb(new Error("Only audio files are allowed"));
  },
});

// ── HuggingFace Space URL ─────────────────────────────────────────────
const PYTHON_AI_URL = process.env.PYTHON_AI_URL || "https://clearwave48-clearwave-api.hf.space";

// ── MongoDB ───────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => {})
  .catch((err) => console.error("MongoDB Error:", err));

app.use("/api/auth", authRoutes);
app.get("/", (req, res) => res.send("ClearWave Backend Running 🚀"));


// ══════════════════════════════════════════════════════════════════════
// HEALTH — verify HF Space is up
// ══════════════════════════════════════════════════════════════════════
app.get("/api/ai/health", async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_AI_URL}/api/health`, { timeout: 10000 });
    res.json({ nodeStatus: "ok", pythonStatus: response.data });
  } catch (err) {
    res.status(503).json({ nodeStatus: "ok", pythonStatus: "unavailable", error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════
// STEP 1: Upload audio → Cloudinary → save to MongoDB
// ══════════════════════════════════════════════════════════════════════
app.post("/upload-audio", upload.single("audio"), async (req, res) => {
  if (req.fileValidationError) {
    return res.status(400).json({ error: req.fileValidationError });
  }

  try {
    const { userId, email } = req.body;
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    if (!userId)   return res.status(400).json({ error: "userId is required" });

    const result = await cloudinary.uploader.upload(req.file.path, { resource_type: "auto" });

    // Clean up temp file regardless of outcome
    fs.unlink(req.file.path, () => {});

    const newAudio = new Audio({ userId, email, audioURL: result.secure_url, speechText: "" });
    await newAudio.save();

    res.json({
      message: "Audio uploaded successfully ✅",
      url:     result.secure_url,
      audioId: newAudio._id,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    // Clean up temp file on error too
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: "Upload failed ❌" });
  }
});

// ── MULTER ERROR HANDLER ───────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum allowed size is 80MB." });
  }
  if (err.message === "Only audio files are allowed") {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});


// ══════════════════════════════════════════════════════════════════════
// STEP 2: Process audio — proxy to HF Space, stream SSE back to React
// ══════════════════════════════════════════════════════════════════════
app.post("/process-audio", async (req, res) => {
  const {
    audioUrl, audioId,
    srcLang     = "auto",
    tgtLang     = "te",
    optFillers  = true,
    optStutters = true,
    optSilences = true,
    optBreaths  = true,
    optMouth    = true,
  } = req.body;

  if (!audioUrl) return res.status(400).json({ error: "audioUrl is required" });

  // SSE headers
  res.setHeader("Content-Type",        "text/event-stream");
  res.setHeader("Cache-Control",       "no-cache");
  res.setHeader("Connection",          "keep-alive");
  res.setHeader("X-Accel-Buffering",   "no");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ status: "processing", step: 0 , message:"connecting to Ai Server.." })}\n\n`);

  try {
    const pythonRes = await fetch(`${PYTHON_AI_URL}/api/process-url`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ audioUrl, audioId, srcLang, tgtLang,
                                optFillers, optStutters, optSilences, optBreaths, optMouth }),
      timeout: 180000,
    });

    if (!pythonRes.ok) {
      const errText = await pythonRes.text().catch(() => "unknown");
      console.error(`[Server] HF Space error: ${pythonRes.status} — ${errText}`);
      res.write(`data: ${JSON.stringify({ status: "error", message: `HF Space error ${pythonRes.status}: ${errText}` })}\n\n`);
      return res.end();
    }

    // Stream HF Space SSE → React (flush each event immediately)
    pythonRes.body.on("data", async (chunk) => {
      const text = chunk.toString();
      const lines = text.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;

        // Write each SSE line individually and flush immediately
        res.write(line + "\n\n");
        if (res.flush) res.flush(); // force flush — bypass nginx/express buffering

        // On done, save results to MongoDB
        if (line.startsWith("data:")) {
          try {
            const data = JSON.parse(line.replace("data: ", ""));
            if (data.status === "done" && audioId) {
              const enhancedAudioUrl = data.enhancedAudio || data.enhancedAudioUrl || data.enhanced_audio_url || "";
              await Audio.findByIdAndUpdate(audioId, {
                speechText:      data.transcript  || "",
                translation:     data.translation || "",
                summary:         data.summary     || "",
                stats:           data.stats       || {},
                enhancedAudioUrl,
                enhancedAt:      new Date(),
              });
            }
          } catch (_) { /* ignore partial chunk parse errors */ }
        }
      }
    });

    pythonRes.body.on("end",   () => res.end());
    pythonRes.body.on("error", (err) => {
      console.error("[Server] SSE stream error:", err.message);
      res.write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error("HF Space error:", err.message);
    res.write(`data: ${JSON.stringify({ status: "error", message: `❌ ${err.message}` })}\n\n`);
    res.end();
  }
});


// ══════════════════════════════════════════════════════════════════════
// GET user uploads — with pagination (?limit=20&skip=0)
// ══════════════════════════════════════════════════════════════════════
app.get("/my-uploads/:userId", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip  = parseInt(req.query.skip) || 0;
    const [audios, total] = await Promise.all([
      Audio.find({ userId: req.params.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Audio.countDocuments({ userId: req.params.userId }),
    ]);
    res.json({ audios, total, limit, skip });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch uploads" });
  }
});

// ══════════════════════════════════════════════════════════════════════
// DELETE a single upload
// ══════════════════════════════════════════════════════════════════════
app.delete("/my-uploads/:id", async (req, res) => {
  try {
    const audio = await Audio.findById(req.params.id);
    if (!audio) return res.status(404).json({ error: "Not found" });

    // Delete enhanced audio from Cloudinary if it exists
    if (audio.enhancedAudioUrl) {
      try {
        // Extract public_id from Cloudinary URL
        const parts = audio.enhancedAudioUrl.split("/");
        const file  = parts[parts.length - 1].split(".")[0];
        const folder = parts[parts.length - 2];
        const publicId = `${folder}/${file}`;
        await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
      } catch (cdnErr) {
        console.warn("[Server] Cloudinary delete failed:", cdnErr.message);
        // Don't block deletion even if Cloudinary cleanup fails
      }
    }

    await Audio.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Node.js running on port ${PORT}`);
  console.log(`🤗 HuggingFace Space: ${PYTHON_AI_URL}`);
});
