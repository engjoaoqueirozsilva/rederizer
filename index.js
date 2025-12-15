import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
const upload = multer({ dest: os.tmpdir() });

/**
 * ffprobe → duração do áudio
 */
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${audioPath}"`,
      (err, stdout) => {
        if (err) return reject(err);
        const duration = parseFloat(stdout.trim());
        console.log(`📊 Duração do áudio: ${duration}s`);
        resolve(duration);
      }
    );
  });
}

/**
 * Cria arquivo concat
 * IMPORTANTE: precisa repetir a última imagem SEM duração
 */
function createConcatFile(images, duration, filePath) {
  let content = "";
  images.forEach((img, index) => {
    // Normaliza o caminho para o formato correto
    const normalizedPath = img.replace(/\\/g, '/');
    content += `file '${normalizedPath}'\n`;
    content += `duration ${duration}\n`;
  });
  // Adiciona a última imagem novamente SEM duração (requisito do concat demuxer)
  const lastImage = images[images.length - 1].replace(/\\/g, '/');
  content += `file '${lastImage}'\n`;
  
  fs.writeFileSync(filePath, content);
  console.log(`📝 Arquivo concat criado:\n${content}`);
}

/**
 * Endpoint final
 */
app.post(
  "/render",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "images", maxCount: 20 }
  ]),
  async (req, res) => {
    try {
      const orientation = req.body.orientation || "landscape";

      if (!req.files?.audio || !req.files?.images) {
        return res.status(400).json({ error: "audio and images are required" });
      }

      const audioPath = req.files.audio[0].path;
      const imagePaths = req.files.images.map(f => f.path);

      console.log(`🎵 Áudio: ${audioPath}`);
      console.log(`🖼️  Imagens: ${imagePaths.length} arquivos`);

      const audioDuration = await getAudioDuration(audioPath);
      const durationPerImage = audioDuration / imagePaths.length;

      console.log(`⏱️  Duração por imagem: ${durationPerImage}s`);

      const concatFile = path.join(os.tmpdir(), `images-${Date.now()}.txt`);
      const outputFile = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);

      createConcatFile(imagePaths, durationPerImage, concatFile);

      const videoFilter =
        orientation === "portrait"
          ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
          : "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080";

      // Comando FFmpeg otimizado
      const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 -vf "${videoFilter}" -c:v libx264 -preset fast -profile:v high -level 4.2 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${outputFile}"`;

      console.log(`🎬 Executando FFmpeg...`);

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("❌ FFmpeg error:", stderr);
          return res.status(500).json({ error: "ffmpeg failed", details: stderr });
        }

        console.log("✅ Vídeo gerado com sucesso!");
        console.log("FFmpeg output:", stderr); // FFmpeg usa stderr para logs

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="video.mp4"`
        );

        const readStream = fs.createReadStream(outputFile);
        
        readStream.on("error", (streamErr) => {
          console.error("❌ Erro ao ler arquivo:", streamErr);
          res.status(500).json({ error: "Failed to read output file" });
        });

        readStream.on("close", () => {
          console.log("🧹 Limpando arquivos temporários...");
          try {
            fs.unlinkSync(outputFile);
            fs.unlinkSync(concatFile);
            fs.unlinkSync(audioPath);
            imagePaths.forEach(p => fs.unlinkSync(p));
          } catch (cleanupErr) {
            console.error("⚠️  Erro ao limpar arquivos:", cleanupErr);
          }
        });

        readStream.pipe(res);
      });
    } catch (err) {
      console.error("❌ Erro geral:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg render worker running on port ${PORT}`);
});