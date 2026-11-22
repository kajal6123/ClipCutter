
const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*"
}));

const uploadDir = path.join(os.tmpdir(), "clipcutter-uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Please upload a video file."));
    }
  }
});

app.get("/", (req, res) => {
  res.json({
    app: "ClipCutter Backend",
    status: "running"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/trim", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Video is required." });
  }

  const start = Number(req.body.start);
  const end = Number(req.body.end);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end - start > 600
  ) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      error: "Invalid trim times. Maximum clip length is 10 minutes."
    });
  }

  const outputName = crypto.randomUUID() + ".mp4";
  const outputPath = path.join(uploadDir, outputName);
  const duration = end - start;

  const ffmpeg = spawn("ffmpeg", [
    "-y",
    "-ss", String(start),
    "-i", req.file.path,
    "-t", String(duration),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outputPath
  ]);

  let errorText = "";

  ffmpeg.stderr.on("data", data => {
    errorText += data.toString();
  });

  ffmpeg.on("error", () => {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({
      error: "FFmpeg could not start. Check server installation."
    });
  });

  ffmpeg.on("close", code => {
    fs.unlink(req.file.path, () => {});

    if (code !== 0) {
      fs.unlink(outputPath, () => {});
      return res.status(500).json({
        error: "Video processing failed."
      });
    }

    res.download(outputPath, "clipcutter-export.mp4", () => {
      fs.unlink(outputPath, () => {});
    });
  });
});

app.use((err, req, res, next) => {
  if (req.file?.path) {
    fs.unlink(req.file.path, () => {});
  }

  res.status(400).json({
    error: err.message || "Request failed."
  });
});

app.listen(PORT, () => {
  console.log("ClipCutter backend running on port " + PORT);
});
