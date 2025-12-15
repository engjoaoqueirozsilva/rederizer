import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const app = express();
const upload = multer({ dest: os.tmpdir() });

// ========== CONFIGURAÇÃO DE SEGURANÇA ==========
const API_SECRET = process.env.API_SECRET || "admin";

/**
 * Middleware de autenticação
 */
function authenticate(req, res, next) {
  const authHeader = req.headers['x-api-key'];
  
  if (!authHeader) {
    return res.status(401).json({ 
      error: "Unauthorized", 
      message: "x-api-key header is required" 
    });
  }

  // Gera hash da secret para comparação
  const validHash = crypto
    .createHash('sha256')
    .update(API_SECRET)
    .digest('hex');

  if (authHeader !== validHash) {
    return res.status(403).json({ 
      error: "Forbidden", 
      message: "Invalid API key" 
    });
  }

  next();
}

// ========== FUNÇÕES AUXILIARES ==========

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
 * Cria arquivo concat com transição
 */
function createConcatFile(images, duration, filePath) {
  let content = "";
  
  // Garante duração mínima de 1 segundo por imagem
  const safeDuration = Math.max(duration, 1.0);
  
  images.forEach((img, index) => {
    const normalizedPath = img.replace(/\\/g, '/');
    content += `file '${normalizedPath}'\n`;
    content += `duration ${safeDuration.toFixed(3)}\n`;
  });
  
  // IMPORTANTE: Adiciona a última imagem novamente SEM duração
  const lastImage = images[images.length - 1].replace(/\\/g, '/');
  content += `file '${lastImage}'\n`;
  
  fs.writeFileSync(filePath, content);
  console.log(`📝 Arquivo concat:\n${content}`);
}

// ========== ENDPOINTS ==========

/**
 * Endpoint de health check (sem autenticação)
 */
app.get("/health", (_, res) => res.json({ status: "ok" }));

/**
 * Endpoint principal de renderização (COM autenticação)
 */
app.post(
  "/render",
  authenticate, // Middleware de autenticação
  upload.fields([
    { name: "narration", maxCount: 1 },  // Áudio principal (narração)
    { name: "background", maxCount: 1 }, // Trilha sonora
    { name: "images", maxCount: 20 }
  ]),
  async (req, res) => {
    try {
      const orientation = req.body.orientation || "landscape";

      if (!req.files?.narration || !req.files?.images) {
        return res.status(400).json({ 
          error: "narration and images are required" 
        });
      }

      const narrationPath = req.files.narration[0].path;
      const backgroundPath = req.files.background?.[0]?.path;
      const imagePaths = req.files.images.map(f => f.path);

      console.log(`🎤 Narração: ${narrationPath}`);
      console.log(`🎵 Trilha: ${backgroundPath || 'Nenhuma'}`);
      console.log(`🖼️  Imagens: ${imagePaths.length} arquivos`);

      const narrationDuration = await getAudioDuration(narrationPath);
      const durationPerImage = narrationDuration / imagePaths.length;

      console.log(`⏱️  Duração total (narração): ${narrationDuration}s`);
      console.log(`⏱️  Duração por imagem: ${durationPerImage}s`);

      if (backgroundPath) {
        const backgroundDuration = await getAudioDuration(backgroundPath);
        const loops = Math.ceil(narrationDuration / backgroundDuration);
        console.log(`🔁 Trilha será repetida ~${loops}x para cobrir ${narrationDuration}s`);
      }

      const concatFile = path.join(os.tmpdir(), `images-${Date.now()}.txt`);
      const outputFile = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);

      createConcatFile(imagePaths, durationPerImage, concatFile);

      // Calcula valores para os filtros de vídeo (zoom + fade)
      const zoomDuration = Math.round(40 * durationPerImage); // frames a 25fps
      const fadeOutStart = (durationPerImage - 0.5).toFixed(2);
      
      const videoFilter =
        orientation === "portrait"
          ? `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`
          : `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080`;
      
      
      
      /*
      const videoFilter =
        orientation === "portrait"
          ? `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0015,1.1)':d=${zoomDuration}:s=1080x1920,fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutStart}:d=0.5`
          : `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.0015,1.1)':d=${zoomDuration}:s=1920x1080,fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutStart}:d=0.5`;
      */

      let cmd;

      if (backgroundPath) {
        // COM trilha sonora: mixa os 2 áudios com loop na trilha
        // [1:a] = narração (volume 1.0 = 100%)
        // [2:a] = background com loop (volume 0.8 = 80%)
        cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -i "${narrationPath}" -stream_loop -1 -i "${backgroundPath}" -filter_complex "[1:a]volume=1.0[narration];[2:a]asetpts=N/SR/TB,volume=0.3[background];[narration][background]amix=inputs=2:duration=first:dropout_transition=2[audio]" -map 0:v:0 -map "[audio]" -vf "${videoFilter}" -c:v libx264 -preset fast -profile:v high -level 4.2 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${outputFile}"`;
      } else {
        // SEM trilha sonora: apenas narração
        cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -i "${narrationPath}" -map 0:v:0 -map 1:a:0 -vf "${videoFilter}" -c:v libx264 -preset fast -profile:v high -level 4.2 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${outputFile}"`;
      }

      console.log(`🎬 Executando FFmpeg...`);

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error("❌ FFmpeg error:", stderr);
          return res.status(500).json({ 
            error: "ffmpeg failed", 
            details: stderr 
          });
        }

        console.log("✅ Vídeo gerado com sucesso!");
        console.log("FFmpeg output:", stderr);

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
            fs.unlinkSync(narrationPath);
            if (backgroundPath) fs.unlinkSync(backgroundPath);
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

// ========== INICIALIZAÇÃO ==========

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎬 FFmpeg render worker running on port ${PORT}`);
  console.log(`🔒 API Secret: ${API_SECRET}`);
  
  // Gera e mostra o hash válido
  const validHash = crypto
    .createHash('sha256')
    .update(API_SECRET)
    .digest('hex');
  console.log(`🔑 Valid API Key (SHA256): ${validHash}`);
});