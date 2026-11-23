
const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(os.tmpdir(), "clipcutter-uploads");

fs.mkdirSync(uploadDir, { recursive: true });

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*"
}));
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Please upload a video file."));
    }
  }
});

function removeFile(file) {
  if (file) fs.unlink(file, () => {});
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", args);
    let errorText = "";

    process.stderr.on("data", data => {
      errorText += data.toString();
    });

    process.on("error", reject);

    process.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg processing failed."));
    });
  });
}

app.get("/", (req, res) => {
  res.json({
    app: "ClipCutter Backend",
    status: "running",
    version: "2.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    aiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

/* MANUAL VIDEO TRIMMING */

app.post("/api/trim", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Video is required." });
  }

  const input = req.file.path;
  const start = Number(req.body.start);
  const end = Number(req.body.end);
  const output = path.join(uploadDir, crypto.randomUUID() + ".mp4");

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end - start > 600
  ) {
    removeFile(input);
    return res.status(400).json({
      error: "Invalid trim times. Maximum clip length is 10 minutes."
    });
  }

  try {
    await runFFmpeg([
      "-y",
      "-ss", String(start),
      "-i", input,
      "-t", String(end - start),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-movflags", "+faststart",
      output
    ]);

    removeFile(input);

    res.download(output, "clipcutter-export.mp4", () => {
      removeFile(output);
    });
  } catch (error) {
    removeFile(input);
    removeFile(output);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/* AI VIDEO HIGHLIGHT ANALYSIS */

app.post("/api/analyze", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Video is required." });
  }

  if (!process.env.GEMINI_API_KEY) {
    removeFile(req.file.path);
    return res.status(503).json({
      error: "Gemini API key is not configured on the backend."
    });
  }

  let uploadedGeminiFile = null;

  try {
    const { GoogleGenAI, createPartFromUri, createUserContent } =
      await import("@google/genai");

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    uploadedGeminiFile = await ai.files.upload({
      file: req.file.path,
      config: {
        mimeType: req.file.mimetype
      }
    });

    // Wait for Gemini to finish processing the video.
    let attempts = 0;

    while (
      !uploadedGeminiFile.state ||
      uploadedGeminiFile.state.toString() !== "ACTIVE"
    ) {
      if (uploadedGeminiFile.state?.toString() === "FAILED") {
        throw new Error("Gemini could not process this video.");
      }

      if (attempts++ >= 36) {
        throw new Error("Video processing took too long. Try a shorter video.");
      }

      await new Promise(resolve => setTimeout(resolve, 5000));

      uploadedGeminiFile = await ai.files.get({
        name: uploadedGeminiFile.name
      });
    }

    const prompt = `
Analyze this video and identify up to 5 interesting short-form
moments suitable for a Shorts or Reels style edit.

Only identify moments actually present in the video.
Do not invent events or dialogue.

Return ONLY valid JSON in this format:

{
  "clips": [
    {
      "start": 12.5,
      "end": 42.5,
      "title": "Short descriptive title",
      "reason": "Why this moment may interest viewers"
    }
  ]
}

Rules:
- Use timestamps in seconds.
- Each clip should be between 15 and 60 seconds.
- Do not overlap clips.
- Keep timestamps within the actual video duration.
- Return fewer clips if there are not enough good moments.
- No markdown fences or extra text.
`;

    const result = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      contents: createUserContent([
        createPartFromUri(
          uploadedGeminiFile.uri,
          uploadedGeminiFile.mimeType
        ),
        prompt
      ])
    });

    let answer = result.text || "";
    answer = answer.replace(/```json/gi, "").replace(/```/g, "").trim();

    const parsed = JSON.parse(answer);

    if (!Array.isArray(parsed.clips)) {
      throw new Error("AI returned an invalid clip list.");
    }

    const clips = parsed.clips
      .filter(clip =>
        Number.isFinite(Number(clip.start)) &&
        Number.isFinite(Number(clip.end)) &&
        Number(clip.start) >= 0 &&
        Number(clip.end) > Number(clip.start) &&
        Number(clip.end) - Number(clip.start) <= 90
      )
      .slice(0, 5)
      .map((clip, index) => ({
        id: index + 1,
        start: Number(clip.start),
        end: Number(clip.end),
        title: String(clip.title || "Highlight " + (index + 1)).slice(0, 100),
        reason: String(clip.reason || "").slice(0, 300)
      }));

    res.json({
      success: true,
      message: "Video analysis completed.",
      clips
    });

  } catch (error) {
    console.error("AI analysis error:", error.message);

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || "AI video analysis failed."
      });
    }

  } finally {
    removeFile(req.file.path);

    if (uploadedGeminiFile) {
      try {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY
        });

        await ai.files.delete({
          name: uploadedGeminiFile.name
        });
      } catch (error) {
        console.log("Temporary Gemini file cleanup skipped.");
      }
    }
  }
});

/* GENERATE MULTIPLE MP4 CLIPS AS ZIP */

app.post("/api/create-clips", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Video is required." });
  }

  let clips;

  try {
    clips = JSON.parse(req.body.clips || "[]");
  } catch (error) {
    removeFile(req.file.path);
    return res.status(400).json({ error: "Invalid clips data." });
  }

  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 5) {
    removeFile(req.file.path);
    return res.status(400).json({
      error: "Choose between 1 and 5 clips."
    });
  }

  for (const clip of clips) {
    const start = Number(clip.start);
    const end = Number(clip.end);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end - start > 90
    ) {
      removeFile(req.file.path);
      return res.status(400).json({ error: "Invalid clip timestamps." });
    }
  }

  const input = req.file.path;
  const outputs = [];

  try {
    for (let i = 0; i < clips.length; i++) {
      const start = Number(clips[i].start);
      const end = Number(clips[i].end);
      const output = path.join(
        uploadDir,
        crypto.randomUUID() + ".mp4"
      );

      await runFFmpeg([
        "-y",
        "-ss", String(start),
        "-i", input,
        "-t", String(end - start),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        output
      ]);

      outputs.push({
        path: output,
        name: "Clip-" + (i + 1) + ".mp4"
      });
    }

    removeFile(input);

    res.attachment("clipcutter-shorts.zip");

    const archive = archiver("zip", {
      zlib: { level: 1 }
    });

    archive.on("error", error => {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).end("Could not create ZIP.");
      }
    });

    archive.pipe(res);

    outputs.forEach(file => {
      archive.file(file.path, { name: file.name });
    });

    archive.on("end", () => {
      outputs.forEach(file => removeFile(file.path));
    });

    res.on("close", () => {
      removeFile(input);
      outputs.forEach(file => removeFile(file.path));
    });

    await archive.finalize();

  } catch (error) {
    removeFile(input);
    outputs.forEach(file => removeFile(file.path));

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || "Clip creation failed."
      });
    }
  }
});

/* ERROR HANDLER */

app.use((err, req, res, next) => {
  if (req.file?.path) {
    removeFile(req.file.path);
  }

  if (!res.headersSent) {
    res.status(400).json({
      error: err.message || "Request failed."
    });
  }
});

app.listen(PORT, () => {
  console.log("ClipCutter backend running on port " + PORT);
});
  
