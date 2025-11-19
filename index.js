import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import dotenv from "dotenv";
import youtubedl from "youtube-dl-exec";
import path from "path";
import fs from "fs";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Api } from "telegram";
import express from "express";
import { Innertube } from "youtubei.js";

// ✅ ADD FFMPEG SUPPORT
// install by # Terminal में run करो: npm install @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import ffprobePath from "@ffprobe-installer/ffprobe";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// ✅ SET FFMPEG PATHS
process.env.FFMPEG_PATH = ffmpegPath.path;
process.env.FFPROBE_PATH = ffprobePath.path;

console.log("✅ FFmpeg path:", ffmpegPath.path);
console.log("✅ FFprobe path:", ffprobePath.path);

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 2000;

const stringSession = new StringSession("");

const client = new TelegramClient(stringSession, API_ID, API_HASH, {
  connectionRetries: 5,
});

const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

const activeDownloads = new Map();
const urlCache = new Map();
const playlistCache = new Map();

// ✅ BETTER COOKIE FILE HANDLING
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);

if (hasCookies) {
  console.log("✅ Cookies file found at:", cookiesPath);
  
  // ✅ CHECK FILE PERMISSIONS & CONTENT
  try {
    const stats = fs.statSync(cookiesPath);
    const content = fs.readFileSync(cookiesPath, 'utf8');
    
    console.log("📊 Cookie file size:", stats.size, "bytes");
    console.log("📊 Cookie lines:", content.split('\n').length);
    console.log("📊 File permissions:", stats.mode.toString(8));
    
    // Verify it's actually YouTube cookies
    if (content.includes('youtube.com')) {
      console.log("✅ YouTube cookies detected!");
    } else {
      console.log("⚠️  Warning: No YouTube cookies found in file");
    }
    
    // Check for expired cookies
    const lines = content.split('\n').filter(l => !l.startsWith('#') && l.trim());
    console.log("📊 Valid cookie lines:", lines.length);
    
  } catch (error) {
    console.log("❌ Cookie file read error:", error.message);
  }
} else {
  console.log("⚠️  No cookies.txt file found. Some videos may not work.");
}

function getYtDlpOptions() {
  const options = {
    noCheckCertificate: true,
    preferFreeFormats: true,
    
    // ✅ CORRECT: Use hyphen, not underscore
    extractorArgs: "youtube:player_client=ios,web",
    
    addHeader: [
      "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language:en-us,en;q=0.5",
      "Sec-Fetch-Mode:navigate",
    ],
  };

  if (hasCookies) {
    const absoluteCookiePath = path.resolve(cookiesPath);
    console.log("🍪 Using cookies from:", absoluteCookiePath);
    
    try {
      fs.accessSync(absoluteCookiePath, fs.constants.R_OK);
      options.cookies = absoluteCookiePath;
      console.log("✅ Cookies file is readable and added to options");
    } catch (error) {
      console.log("❌ Cannot read cookies file:", error.message);
    }
  }

  return options;
}

function isValidYouTubeUrl(url) {
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
  return youtubeRegex.test(url);
}

function isPlaylistUrl(url) {
  return url.includes("list=");
}

function extractPlaylistId(url) {
  const match = url.match(/[?&]list=([^&]+)/);
  return match ? match[1] : null;
}

function sanitizeFilename(filename, maxBytes = 240) {
  // Remove invalid filesystem characters
  let cleaned = filename.replace(/[/\\?%*:|"<>]/g, "-");

  // Check byte length (important for UTF-8/Hindi)
  const byteLength = Buffer.byteLength(cleaned, "utf8");

  // If within safe limit, return full title
  if (byteLength <= maxBytes) {
    console.log(`✅ Full filename: ${cleaned} (${byteLength} bytes)`);
    return cleaned;
  }

  // Truncate safely at byte boundary
  console.log(
    `⚠️ Truncating: ${cleaned.substring(0, 50)}... (${byteLength} bytes)`
  );

  let truncated = cleaned;
  while (Buffer.byteLength(truncated, "utf8") > maxBytes - 3) {
    truncated = truncated.slice(0, -1);
  }

  truncated = truncated.trim() + "...";
  console.log(
    `✅ Truncated to: ${truncated} (${Buffer.byteLength(
      truncated,
      "utf8"
    )} bytes)`
  );

  return truncated;
}

function formatFileSize(bytes) {
  let numBytes;

  if (typeof bytes === "bigint") {
    numBytes = Number(bytes);
  } else if (typeof bytes === "number") {
    numBytes = bytes;
  } else {
    return "0 Bytes";
  }

  if (!numBytes || numBytes === 0 || isNaN(numBytes)) {
    return "0 Bytes";
  }

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(numBytes) / Math.log(k));
  const size = (numBytes / Math.pow(k, i)).toFixed(2);

  return `${size} ${sizes[i]}`;
}

function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function createProgressBar(percentage) {
  const validPercentage = isNaN(percentage)
    ? 0
    : Math.min(Math.max(percentage, 0), 100);

  const totalCubes = 10;
  const filledCubes = Math.floor((validPercentage / 100) * totalCubes);
  const emptyCubes = totalCubes - filledCubes;

  const filled = "🟦".repeat(filledCubes);
  const empty = "⬜".repeat(emptyCubes);

  return `${filled}${empty} ${validPercentage}%`;
}

async function downloadThumbnailToBuffer(thumbnailUrl) {
  try {
    const response = await axios({
      url: thumbnailUrl,
      method: "GET",
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error("Thumbnail download error:", error.message);
    return null;
  }
}

function getBestThumbnail(thumbnails) {
  if (!thumbnails || thumbnails.length === 0) return null;
  const maxRes = thumbnails.find(
    (t) => t.url && t.url.includes("maxresdefault")
  );
  if (maxRes) return maxRes.url;
  const sorted = thumbnails
    .filter((t) => t.url)
    .sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

// Retry helper function with exponential backoff
async function retryOperation(operation, maxRetries = 3, initialDelay = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = initialDelay * Math.pow(2, i); // Exponential backoff
      console.log(`⚠️ Attempt ${i + 1} failed, retrying in ${delay}ms...`);
      console.log(`   Error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function getVideoInfo(url) {
  try {
    console.log("🔍 Fetching video info for:", url);

    // ✅ DIRECT YT-DLP APPROACH (Most reliable)
    const info = await retryOperation(
      async () => {
        return await youtubedl(url, {
          dumpSingleJson: true,
          skipDownload: true,
          noPlaylist: true,
          extractorArgs: "youtube:player_client=ios,web",
          ...getYtDlpOptions(),
        });
      },
      3,
      5000 // Increased delay between retries
    );

    let thumbnailUrl = info.thumbnail;
    if (info.thumbnails && info.thumbnails.length > 0) {
      thumbnailUrl = getBestThumbnail(info.thumbnails) || thumbnailUrl;
    }

    console.log("✅ Video info fetched:", info.title);

    return {
      title: info.title || "Unknown",
      duration: info.duration || 0,
      uploader: info.uploader || info.channel || "Unknown",
      thumbnail: thumbnailUrl,
      url: url,
    };
  } catch (error) {
    console.error("❌ getVideoInfo error:", error.message);

    if (
      error.message.includes("bot") ||
      error.message.includes("Sign in") ||
      error.message.includes("429")
    ) {
      throw new Error(
        "⚠️ YouTube rate limit or bot detection!\n\n" +
        "Solutions:\n" +
        "1. Wait 10-15 minutes\n" +
        "2. Export fresh cookies\n" +
        "3. Try a different video\n" +
        "4. Use VPN if available"
      );
    } else if (error.message.includes("Private video")) {
      throw new Error("This is a private video.");
    } else if (error.message.includes("available")) {
      throw new Error("Video not available.");
    } else if (error.message.includes("copyright")) {
      throw new Error("Video blocked due to copyright.");
    }

    throw new Error(`Failed to get video info: ${error.message}`);
  }
}

async function getPlaylistVideos(playlistId, chatId, messageId) {
  try {
    const loadingMsg = await client.sendMessage(chatId, {
      message: "🔍 Fetching playlist videos...",
      replyTo: messageId,
    });

    const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;

    console.log("📝 Fetching playlist with yt-dlp...");

    // ✅ USE YT-DLP INSTEAD OF YOUTUBEI.JS
    const playlistInfo = await youtubedl(playlistUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      extractorArgs: "youtube:player_client=ios,web",
      ...getYtDlpOptions(),
    });

    await loadingMsg.edit({
      text: `🔍 Processing playlist...\n📊 Found: ${playlistInfo.entries.length} videos`,
    });

    const videos = playlistInfo.entries.map((v) => ({
      title: v.title || "Unknown",
      thumbnail: v.thumbnail || null,
      url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
    }));

    await loadingMsg.delete({ revoke: true });

    console.log(`✅ Playlist loaded: ${videos.length} videos`);
    return videos;
  } catch (error) {
    console.error("Playlist fetch error:", error);
    throw new Error("Failed to fetch playlist: " + error.message);
  }
}

function createQualityButtons(cacheKey, isPlaylist = false) {
  const prefix = isPlaylist ? "pl_quality" : "quality";
  return [
    [
      new Api.KeyboardButtonCallback({
        text: "🎵 MP3 Audio",
        data: Buffer.from(`${prefix}_mp3_${cacheKey}`),
      }),
      new Api.KeyboardButtonCallback({
        text: "📹 360p",
        data: Buffer.from(`${prefix}_360_${cacheKey}`),
      }),
    ],
    [
      new Api.KeyboardButtonCallback({
        text: "📹 480p",
        data: Buffer.from(`${prefix}_480_${cacheKey}`),
      }),
      new Api.KeyboardButtonCallback({
        text: "📹 720p",
        data: Buffer.from(`${prefix}_720_${cacheKey}`),
      }),
    ],
    [
      new Api.KeyboardButtonCallback({
        text: "📹 1080p",
        data: Buffer.from(`${prefix}_1080_${cacheKey}`),
      }),
    ],
  ];
}

async function downloadMP3(url, chatId, messageId, statusMessage) {
  let audioPath = null;
  let thumbPath = null;
  let lastUpdateTime = Date.now();
  let estimatedSize = 0;

  try {
    const videoInfo = await getVideoInfo(url);
    estimatedSize = (videoInfo.duration / 60) * 1.2 * 1024 * 1024;

    await statusMessage.edit({
      text:
        `🎵 <b>${videoInfo.title}</b>\n\n` +
        `👤 Channel: ${videoInfo.uploader}\n` +
        `⏱ Duration: ${formatDuration(videoInfo.duration)}\n\n` +
        `⬇️ Downloading audio...\n` +
        createProgressBar(0),
      parseMode: "html",
    });

    // ✅ USE VIDEO TITLE AS FILENAME
    const sanitizedTitle = sanitizeFilename(videoInfo.title);
    const timestamp = Date.now();
    audioPath = path.join(tempDir, `${sanitizedTitle}_${timestamp}.mp3`);

    console.log("⬇️ Starting MP3 download...");
    console.log(`📁 Filename: ${sanitizedTitle}.mp3`);

const downloadPromise = youtubedl(url, {
  extractAudio: true,
  audioFormat: "mp3",
  audioQuality: 0,
  output: audioPath,
  noPlaylist: true,
  extractorArgs: "youtube:player_client=ios,web", // ✅ Correct option
  ffmpegLocation: ffmpegPath.path,
  ...getYtDlpOptions(),
});

    const progressInterval = setInterval(async () => {
      const now = Date.now();
      if (now - lastUpdateTime >= 5000 && fs.existsSync(audioPath)) {
        lastUpdateTime = now;
        const stats = fs.statSync(audioPath);
        const currentSize = stats.size;
        const progress = Math.min(
          Math.floor((currentSize / estimatedSize) * 100),
          99
        );
        const sizeMB = (currentSize / (1024 * 1024)).toFixed(2);

        try {
          await statusMessage.edit({
            text:
              `🎵 <b>${videoInfo.title}</b>\n\n` +
              `⬇️ Downloading audio...\n` +
              createProgressBar(progress) +
              `\n📊 Downloaded: ${sizeMB} MB`,
            parseMode: "html",
          });
          console.log(`Download progress: ${progress}% (${sizeMB} MB)`);
        } catch (e) {
          console.error("Download progress update error:", e.message);
        }
      }
    }, 1000);

    await downloadPromise;
    clearInterval(progressInterval);

    if (!fs.existsSync(audioPath)) {
      throw new Error("Download failed - file not created");
    }

    console.log("✅ Download complete");

    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    const totalFileSize = stats.size;

    console.log(`📊 File size: ${formatFileSize(stats.size)}`);

    if (fileSizeMB > MAX_FILE_SIZE) {
      await statusMessage.edit({
        text: `❌ File too large: ${formatFileSize(
          stats.size
        )}\n\nMax limit: ${MAX_FILE_SIZE}MB`,
      });
      fs.unlinkSync(audioPath);
      return;
    }

    let thumbnailBuffer = null;
    if (videoInfo.thumbnail) {
      thumbnailBuffer = await downloadThumbnailToBuffer(videoInfo.thumbnail);
      if (thumbnailBuffer) {
        thumbPath = path.join(
          tempDir,
          `${sanitizedTitle}_${timestamp}_thumb.jpg`
        );
        fs.writeFileSync(thumbPath, thumbnailBuffer);
      }
    }

    await statusMessage.edit({
      text:
        `🎵 <b>${videoInfo.title}</b>\n\n` +
        `📤 Uploading...\n` +
        createProgressBar(0) +
        `\n📊 Size: ${formatFileSize(stats.size)}`,
      parseMode: "html",
    });

    console.log("📤 Starting upload...");

    let lastProgress = 0;
    lastUpdateTime = Date.now();

    // ✅ UPLOAD WITH PROPER FILENAME
    await client.sendFile(chatId, {
      file: audioPath,
      caption: `🎵 ${videoInfo.title}\n\n👤 ${videoInfo.uploader}`,
      attributes: [
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizedTitle}.mp3`, // ✅ Clean filename
        }),
        new Api.DocumentAttributeAudio({
          duration: videoInfo.duration,
          title: videoInfo.title,
          performer: videoInfo.uploader,
        }),
      ],
      thumb: thumbPath || undefined,
      replyTo: messageId,
      progressCallback: async (uploaded, total) => {
        try {
          const totalSize = total || totalFileSize;
          const uploadedSize = uploaded || 0;

          const uploadedNum =
            typeof uploadedSize === "number"
              ? uploadedSize
              : Number(uploadedSize);
          const totalNum =
            typeof totalSize === "number" ? totalSize : Number(totalSize);

          let actualUploaded, actualTotal;

          if (uploadedNum < 1 && uploadedNum > 0) {
            actualUploaded = Math.floor(uploadedNum * totalNum);
            actualTotal = totalNum;
          } else {
            actualUploaded = uploadedNum;
            actualTotal = totalNum;
          }

          const progress = Math.min(
            Math.floor((actualUploaded / actualTotal) * 100),
            100
          );
          const now = Date.now();

          if (now - lastUpdateTime >= 10000 || progress - lastProgress >= 5) {
            lastUpdateTime = now;
            lastProgress = progress;

            await statusMessage.edit({
              text:
                `🎵 <b>${videoInfo.title}</b>\n\n` +
                `📤 Uploading...\n` +
                createProgressBar(progress) +
                `\n📊 ${formatFileSize(actualUploaded)} / ${formatFileSize(
                  actualTotal
                )}`,
              parseMode: "html",
            });
          }
        } catch (e) {
          console.error("Upload progress callback error:", e.message);
        }
      },
    });

    console.log("✅ Upload complete");

    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      await client.invoke(
        new Api.messages.DeleteMessages({
          id: [statusMessage.id],
          revoke: true,
        })
      );
      console.log("✅ Progress message deleted successfully");
    } catch (e) {
      try {
        await statusMessage.delete({ revoke: true });
      } catch (e2) {}
    }

    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    console.log("✅ Cleanup done\n");
  } catch (error) {
    console.error("❌ Error:", error.message);
    throw error;
  }
}

// ✅ ADD THIS NEW FUNCTION
import { promisify } from "util";
import { exec } from "child_process";
const execPromise = promisify(exec);

async function fixVideoForStreaming(inputPath, outputPath) {
  try {
    console.log("🔧 Fixing video for streaming...");

    // Use FFmpeg to move MOOV atom to beginning for streaming
    const command = `"${ffmpegPath.path}" -i "${inputPath}" -c copy -movflags +faststart -y "${outputPath}"`;

    await execPromise(command);

    console.log("✅ Video fixed for streaming");
    return true;
  } catch (error) {
    console.error("⚠️ Video fix failed:", error.message);
    // If fix fails, use original file
    return false;
  }
}

async function downloadVideo(url, chatId, messageId, quality, statusMessage) {
  let videoPath = null;
  let thumbPath = null;
  let lastUpdateTime = Date.now();
  let estimatedSize = 0;

  try {
    const videoInfo = await getVideoInfo(url);

    const sizePerMinute = {
      360: 5,
      480: 8,
      720: 15,
      1080: 25,
    };
    estimatedSize =
      (videoInfo.duration / 60) * (sizePerMinute[quality] || 5) * 1024 * 1024;

    let formatString;
    let qualityLabel;

    switch (quality) {
      case "360":
        formatString =
          "best[height<=360][ext=mp4]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]";
        qualityLabel = "360p";
        break;
      case "480":
        formatString =
          "best[height<=480][ext=mp4]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]";
        qualityLabel = "480p";
        break;
      case "720":
        formatString =
          "best[height<=720][ext=mp4]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]";
        qualityLabel = "720p";
        break;
      case "1080":
        formatString =
          "best[height<=1080][ext=mp4]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]";
        qualityLabel = "1080p";
        break;
      default:
        formatString = "best[height<=360][ext=mp4]";
        qualityLabel = "360p";
    }

    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `👤 Channel: ${videoInfo.uploader}\n` +
        `⏱ Duration: ${formatDuration(videoInfo.duration)}\n` +
        `🎬 Quality: ${qualityLabel}\n\n` +
        `⬇️ Downloading video...\n` +
        createProgressBar(0),
      parseMode: "html",
    });

    // ✅ USE VIDEO TITLE AS FILENAME
    const sanitizedTitle = sanitizeFilename(videoInfo.title);
    const timestamp = Date.now();
    videoPath = path.join(tempDir, `${sanitizedTitle}_${timestamp}.mp4`);

    console.log(`⬇️ Starting ${qualityLabel} video download...`);
    console.log(`📁 Filename: ${sanitizedTitle}.mp4`);

const downloadPromise = youtubedl(url, {
  format: formatString,
  output: videoPath,
  noPlaylist: true,
  mergeOutputFormat: "mp4",
  extractorArgs: "youtube:player_client=ios,web", // ✅ Correct option
  ...getYtDlpOptions(),
});

    const progressInterval = setInterval(async () => {
      const now = Date.now();
      if (now - lastUpdateTime >= 5000 && fs.existsSync(videoPath)) {
        lastUpdateTime = now;
        const stats = fs.statSync(videoPath);
        const currentSize = stats.size;
        const progress = Math.min(
          Math.floor((currentSize / estimatedSize) * 100),
          99
        );
        const sizeMB = (currentSize / (1024 * 1024)).toFixed(2);

        try {
          await statusMessage.edit({
            text:
              `📹 <b>${videoInfo.title}</b>\n\n` +
              `🎬 Quality: ${qualityLabel}\n` +
              `⬇️ Downloading video...\n` +
              createProgressBar(progress) +
              `\n📊 Downloaded: ${sizeMB} MB`,
            parseMode: "html",
          });
          console.log(`Download progress: ${progress}% (${sizeMB} MB)`);
        } catch (e) {
          console.error("Download progress update error:", e.message);
        }
      }
    }, 1000);

    await downloadPromise;
    clearInterval(progressInterval);

    if (!fs.existsSync(videoPath)) {
      throw new Error("Download failed - file not created");
    }

    console.log("✅ Download complete");

    // ✅ FIX VIDEO FOR STREAMING
    const fixedVideoPath = path.join(
      tempDir,
      `${sanitizedTitle}_${timestamp}_fixed.mp4`
    );
    const fixSuccess = await fixVideoForStreaming(videoPath, fixedVideoPath);

    let finalVideoPath = videoPath;
    if (fixSuccess && fs.existsSync(fixedVideoPath)) {
      // Delete original and use fixed version
      fs.unlinkSync(videoPath);
      finalVideoPath = fixedVideoPath;
      console.log("✅ Using streaming-optimized video");
    } else {
      console.log("⚠️ Using original video (fix failed)");
    }

    const stats = fs.statSync(finalVideoPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    const totalFileSize = stats.size;

    console.log(`📊 File size: ${formatFileSize(stats.size)}`);

    if (fileSizeMB > MAX_FILE_SIZE) {
      await statusMessage.edit({
        text: `❌ File too large: ${formatFileSize(
          stats.size
        )}\n\nMax limit: ${MAX_FILE_SIZE}MB\n\nTry a lower quality.`,
      });
      fs.unlinkSync(finalVideoPath);
      return;
    }

    let thumbnailBuffer = null;
    if (videoInfo.thumbnail) {
      thumbnailBuffer = await downloadThumbnailToBuffer(videoInfo.thumbnail);
      if (thumbnailBuffer) {
        thumbPath = path.join(
          tempDir,
          `${sanitizedTitle}_${timestamp}_thumb.jpg`
        );
        fs.writeFileSync(thumbPath, thumbnailBuffer);
      }
    }

    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `🎬 Quality: ${qualityLabel}\n` +
        `📤 Uploading...\n` +
        createProgressBar(0) +
        `\n📊 Size: ${formatFileSize(stats.size)}`,
      parseMode: "html",
    });

    console.log("📤 Starting upload...");

    const dimensions = {
      360: { w: 640, h: 360 },
      480: { w: 854, h: 480 },
      720: { w: 1280, h: 720 },
      1080: { w: 1920, h: 1080 },
    };

    const { w, h } = dimensions[quality] || { w: 640, h: 360 };

    let lastProgress = 0;
    lastUpdateTime = Date.now();

    // ✅ UPLOAD WITH PROPER FILENAME
    await client.sendFile(chatId, {
      file: finalVideoPath,
      caption: `📹 ${videoInfo.title}\n\n👤 ${videoInfo.uploader}\n🎬 Quality: ${qualityLabel}`,
      attributes: [
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizedTitle}.mp4`, // ✅ Clean filename
        }),
        new Api.DocumentAttributeVideo({
          duration: videoInfo.duration,
          w: w,
          h: h,
          supportsStreaming: true,
        }),
      ],
      thumb: thumbPath || undefined,
      replyTo: messageId,
      supportsStreaming: true,
      progressCallback: async (uploaded, total) => {
        try {
          const totalSize = total || totalFileSize;
          const uploadedSize = uploaded || 0;

          const uploadedNum =
            typeof uploadedSize === "number"
              ? uploadedSize
              : Number(uploadedSize);
          const totalNum =
            typeof totalSize === "number" ? totalSize : Number(totalSize);

          let actualUploaded, actualTotal;

          if (uploadedNum < 1 && uploadedNum > 0) {
            actualUploaded = Math.floor(uploadedNum * totalNum);
            actualTotal = totalNum;
          } else {
            actualUploaded = uploadedNum;
            actualTotal = totalNum;
          }

          const progress = Math.min(
            Math.floor((actualUploaded / actualTotal) * 100),
            100
          );
          const now = Date.now();

          if (now - lastUpdateTime >= 10000 || progress - lastProgress >= 5) {
            lastUpdateTime = now;
            lastProgress = progress;

            await statusMessage.edit({
              text:
                `📹 <b>${videoInfo.title}</b>\n\n` +
                `🎬 Quality: ${qualityLabel}\n` +
                `📤 Uploading...\n` +
                createProgressBar(progress) +
                `\n📊 ${formatFileSize(actualUploaded)} / ${formatFileSize(
                  actualTotal
                )}`,
              parseMode: "html",
            });
          }
        } catch (e) {
          console.error("Upload progress callback error:", e.message);
        }
      },
    });

    console.log("✅ Upload complete");

    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      await client.invoke(
        new Api.messages.DeleteMessages({
          id: [statusMessage.id],
          revoke: true,
        })
      );
      console.log("✅ Progress message deleted successfully");
    } catch (e) {
      try {
        await statusMessage.delete({ revoke: true });
      } catch (e2) {}
    }

    if (fs.existsSync(finalVideoPath)) fs.unlinkSync(finalVideoPath); // ✅ Clean fixed video
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    console.log("✅ Cleanup done\n");
  } catch (error) {
    console.error("❌ Error:", error.message);
    throw error;
  }
}

async function downloadPlaylist(videos, chatId, messageId, quality) {
  const totalVideos = videos.length;
  let successCount = 0;
  let failedCount = 0;

  const statusMessage = await client.sendMessage(chatId, {
    message: `📝 Starting playlist download\n📊 Total videos: ${totalVideos}\n\n⏳ Processing...`,
    replyTo: messageId,
  });

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const videoNumber = i + 1;

    try {
      await statusMessage.edit({
        text:
          `📝 Downloading Playlist\n\n` +
          `📊 Progress: ${videoNumber}/${totalVideos}\n` +
          `✅ Success: ${successCount}\n` +
          `❌ Failed: ${failedCount}\n\n` +
          `⬇️ Current: ${video.title.substring(0, 50)}...`,
        parseMode: "html",
      });

      const videoStatusMsg = await client.sendMessage(chatId, {
        message: `⏳ [${videoNumber}/${totalVideos}] Processing...`,
        replyTo: messageId,
      });

      // Add delay between videos to avoid rate limiting
      if (i > 0) {
        const delay = 5000; // 5 seconds between videos
        console.log(`⏳ Waiting ${delay}ms before next download...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (quality === "mp3") {
        await downloadMP3(video.url, chatId, messageId, videoStatusMsg);
      } else {
        await downloadVideo(
          video.url,
          chatId,
          messageId,
          quality,
          videoStatusMsg
        );
      }

      successCount++;
      console.log(
        `✅ [${videoNumber}/${totalVideos}] Downloaded: ${video.title}`
      );
    } catch (error) {
      failedCount++;
      console.error(
        `❌ [${videoNumber}/${totalVideos}] Failed: ${video.title}`,
        error.message
      );

      await client.sendMessage(chatId, {
        message: `❌ [${videoNumber}/${totalVideos}] Failed: ${video.title.substring(
          0,
          50
        )}...\n\nError: ${error.message}`,
        replyTo: messageId,
      });
    }
  }

  await statusMessage.edit({
    text:
      `✅ <b>Playlist Download Complete!</b>\n\n` +
      `📊 Total videos: ${totalVideos}\n` +
      `✅ Successfully downloaded: ${successCount}\n` +
      `❌ Failed: ${failedCount}\n\n` +
      `🎉 All done!`,
    parseMode: "html",
  });

  console.log(
    `\n🎉 Playlist finished: ${successCount}/${totalVideos} successful`
  );
}

async function showQualitySelector(
  url,
  chatId,
  messageId,
  isPlaylist = false,
  videos = null
) {
  let loadingMsg = null;

  try {
    loadingMsg = await client.sendMessage(chatId, {
      message: isPlaylist
        ? "🔍 Getting playlist information..."
        : "🔍 Getting video information...",
      replyTo: messageId,
    });

    console.log("📤 Loading message sent");

    const cacheKey = Date.now().toString(36);

    if (isPlaylist) {
      playlistCache.set(cacheKey, {
        videos: videos,
        originalMessageId: messageId,
      });

      setTimeout(() => {
        playlistCache.delete(cacheKey);
      }, 600000);

      await client.sendMessage(chatId, {
        message:
          `📝 <b>Playlist Ready</b>\n\n` +
          `📊 Total videos: ${videos.length}\n\n` +
          `<b>Select quality for all videos:</b>`,
        parseMode: "html",
        buttons: createQualityButtons(cacheKey, true),
        replyTo: messageId,
      });
    } else {
      const videoInfo = await getVideoInfo(url);

      urlCache.set(cacheKey, {
        ...videoInfo,
        originalMessageId: messageId,
      });

      setTimeout(() => {
        urlCache.delete(cacheKey);
      }, 600000);

      let qualitySelectorMsg = null;

      if (videoInfo.thumbnail) {
        const thumbnailBuffer = await downloadThumbnailToBuffer(
          videoInfo.thumbnail
        );

        if (thumbnailBuffer) {
          const tempThumbPath = path.join(tempDir, `${cacheKey}_temp.jpg`);
          fs.writeFileSync(tempThumbPath, thumbnailBuffer);

          qualitySelectorMsg = await client.sendFile(chatId, {
            file: tempThumbPath,
            caption:
              `📹 <b>${videoInfo.title}</b>\n\n` +
              `👤 Channel: ${videoInfo.uploader}\n` +
              `⏱ Duration: ${formatDuration(videoInfo.duration)}\n\n` +
              `<b>Select quality:</b>`,
            parseMode: "html",
            buttons: createQualityButtons(cacheKey),
            replyTo: messageId,
          });

          console.log("📤 Quality selector with thumbnail sent");

          setTimeout(() => {
            if (fs.existsSync(tempThumbPath)) {
              fs.unlinkSync(tempThumbPath);
            }
          }, 5000);
        }
      }

      if (!qualitySelectorMsg) {
        qualitySelectorMsg = await client.sendMessage(chatId, {
          message:
            `📹 <b>${videoInfo.title}</b>\n\n` +
            `👤 Channel: ${videoInfo.uploader}\n` +
            `⏱ Duration: ${formatDuration(videoInfo.duration)}\n\n` +
            `<b>Select quality:</b>`,
          parseMode: "html",
          buttons: createQualityButtons(cacheKey),
          replyTo: messageId,
        });

        console.log("📤 Quality selector (text) sent");
      }
    }

    if (loadingMsg) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await loadingMsg.delete({ revoke: true });
        console.log("✅ Loading message deleted successfully");
      } catch (e) {
        console.error("❌ Failed to delete loading message:", e.message);
        try {
          await client.invoke(
            new Api.messages.DeleteMessages({
              id: [loadingMsg.id],
              revoke: true,
            })
          );
          console.log("✅ Loading message deleted (alternative method)");
        } catch (e2) {
          console.error("❌ Alternative delete also failed:", e2.message);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error:", error.message);

    if (loadingMsg) {
      try {
        await loadingMsg.delete({ revoke: true });
      } catch (e) {}
    }

    await client.sendMessage(chatId, {
      message: `❌ Error: ${error.message}`,
      replyTo: messageId,
    });
  }
}

async function main() {
  console.log("🔐 Connecting to Telegram...");

  await client.start({
    botAuthToken: BOT_TOKEN,
  });

  console.log("✅ Bot connected!");
  console.log("📊 Max file size:", MAX_FILE_SIZE, "MB");

  if (!hasCookies) {
    console.log("\n⚠️  WARNING: No cookies.txt file found!");
    console.log("   Some videos may fail due to YouTube bot detection.");
    console.log("   To fix this:");
    console.log("   1. Install browser extension: Get cookies.txt LOCALLY");
    console.log("   2. Visit youtube.com while logged in");
    console.log(
      "   3. Export cookies and save as cookies.txt in project root\n"
    );
  }

  const sessionString = client.session.save();
  console.log("💾 Session saved");

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.text) return;

      const chatId = message.chatId || message.peerId || message.chat?.id;
      const messageId = message.id;
      const text = message.text;

      console.log("📩 Received:", text, "from", chatId);

      if (text === "/start") {
        const cookieStatus = hasCookies ? "✅ Active" : "❌ Missing";
        await client.sendMessage(chatId, {
          message:
            `👋 <b>Welcome to YouTube Downloader Bot!</b>\n\n` +
            `📹 Send me any YouTube link (video or playlist)\n\n` +
            `<b>Available Formats:</b>\n` +
            `🎵 MP3 Audio (320kbps)\n` +
            `📹 360p Video\n` +
            `📹 480p Video\n` +
            `📹 720p Video\n` +
            `📹 1080p Video\n\n` +
            `<b>Features:</b>\n` +
            `✅ Single video download\n` +
            `✅ Full playlist download\n` +
            `✅ Download progress (updates every 5s)\n` +
            `✅ Upload progress (updates every 10s)\n` +
            `✅ Visual progress indicators\n` +
            `✅ Thumbnail preview\n` +
            `✅ Multiple quality options\n` +
            `✅ Auto-retry on failures\n\n` +
            `🍪 Cookies Status: ${cookieStatus}\n` +
            `⚠️ Max file size: ${MAX_FILE_SIZE}MB`,
          parseMode: "html",
        });
      } else if (text === "/help") {
        await client.sendMessage(chatId, {
          message:
            `📖 <b>Help</b>\n\n` +
            `<b>How to use:</b>\n` +
            `1. Send any YouTube video or playlist link\n` +
            `2. Choose your preferred quality\n` +
            `3. Watch progress with visual indicators\n` +
            `4. Enjoy your media!\n\n` +
            `<b>Supported links:</b>\n` +
            `✅ youtube.com/watch?v=...\n` +
            `✅ youtu.be/...\n` +
            `✅ youtube.com/playlist?list=...\n` +
            `✅ youtube.com/watch?v=...&list=...\n\n` +
            `<b>Fix Bot Detection Error:</b>\n` +
            `If you see "Sign in to confirm you're not a bot":\n\n` +
            `1. Install browser extension:\n` +
            `   • Chrome: "Get cookies.txt LOCALLY"\n` +
            `   • Firefox: "cookies.txt"\n\n` +
            `2. Go to youtube.com (logged in)\n` +
            `3. Click extension → Export\n` +
            `4. Save as "cookies.txt" in bot folder\n` +
            `5. Restart the bot\n\n` +
            `<b>Playlist Download:</b>\n` +
            `📝 All videos downloaded sequentially\n` +
            `📊 Progress updates for each video\n` +
            `⏳ 5 second delay between videos\n` +
            `✅ Completion summary at the end\n\n` +
            `<b>Quality options:</b>\n` +
            `🎵 MP3 - Audio only (320kbps)\n` +
            `📹 360p - Low quality (~5MB/min)\n` +
            `📹 480p - Standard quality (~8MB/min)\n` +
            `📹 720p - HD quality (~15MB/min)\n` +
            `📹 1080p - Full HD quality (~25MB/min)\n\n` +
            `<b>Limitations:</b>\n` +
            `⚠️ Max file size: ${MAX_FILE_SIZE}MB\n` +
            `⚠️ One download at a time per user\n` +
            `⚠️ Quality selector expires after 10 min`,
          parseMode: "html",
        });
      } else if (isValidYouTubeUrl(text)) {
        console.log("📹 Processing YouTube URL...");

        if (isPlaylistUrl(text)) {
          const playlistId = extractPlaylistId(text);
          if (playlistId) {
            console.log("📝 Playlist detected:", playlistId);
            const videos = await getPlaylistVideos(
              playlistId,
              chatId,
              messageId
            );
            await showQualitySelector(text, chatId, messageId, true, videos);
          } else {
            await client.sendMessage(chatId, {
              message: "❌ Invalid playlist URL",
              replyTo: messageId,
            });
          }
        } else {
          await showQualitySelector(text, chatId, messageId, false);
        }
      } else if (text.length > 10 && !text.startsWith("/")) {
        await client.sendMessage(chatId, {
          message: "❌ Please send a valid YouTube URL",
          replyTo: messageId,
        });
      }
    } catch (error) {
      console.error("❌ Event handler error:", error.message);
    }
  }, new NewMessage({}));

  client.addEventHandler(async (update) => {
    try {
      if (update.className === "UpdateBotCallbackQuery") {
        const data = update.data.toString();
        const chatId = update.peer;
        const msgId = update.msgId;

        console.log("🔘 Button clicked:", data);

        const parts = data.split("_");

        let isPlaylist = false;
        let qualityType, cacheKey;

        if (parts[0] === "pl") {
          isPlaylist = true;
          qualityType = parts[2];
          cacheKey = parts[3];
        } else {
          qualityType = parts[1];
          cacheKey = parts[2];
        }

        if (isPlaylist) {
          const cachedPlaylist = playlistCache.get(cacheKey);
          if (!cachedPlaylist) {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ Session expired. Please send the link again.",
                alert: true,
              })
            );
            return;
          }

          await client.invoke(
            new Api.messages.SetBotCallbackAnswer({
              queryId: update.queryId,
              message: "✅ Starting playlist download...",
            })
          );

          const chatIdStr = chatId.userId?.toString() || chatId.toString();
          if (activeDownloads.has(chatIdStr)) {
            await client.sendMessage(chatId, {
              message:
                "⚠️ You already have an active download. Please wait for it to complete.",
            });
            return;
          }

          activeDownloads.set(chatIdStr, true);

          try {
            await client.invoke(
              new Api.messages.DeleteMessages({
                id: [msgId],
                revoke: true,
              })
            );
            console.log("✅ Quality selector deleted");
          } catch (e) {
            console.error("❌ Failed to delete quality selector:", e.message);
          }

          try {
            await downloadPlaylist(
              cachedPlaylist.videos,
              chatId,
              cachedPlaylist.originalMessageId,
              qualityType
            );
          } catch (error) {
            await client.sendMessage(chatId, {
              message: `❌ Playlist download error: ${error.message}`,
            });
          } finally {
            activeDownloads.delete(chatIdStr);
          }
        } else {
          const cachedData = urlCache.get(cacheKey);
          if (!cachedData) {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ Session expired. Please send the link again.",
                alert: true,
              })
            );
            return;
          }

          const url = cachedData.url;
          const originalMessageId = cachedData.originalMessageId;

          await client.invoke(
            new Api.messages.SetBotCallbackAnswer({
              queryId: update.queryId,
              message: "✅ Processing...",
            })
          );

          const chatIdStr = chatId.userId?.toString() || chatId.toString();
          if (activeDownloads.has(chatIdStr)) {
            await client.sendMessage(chatId, {
              message:
                "⚠️ You already have an active download. Please wait for it to complete.",
            });
            return;
          }

          activeDownloads.set(chatIdStr, true);

          const statusMessage = await client.sendMessage(chatId, {
            message: "⏳ Initializing download...",
            replyTo: originalMessageId,
          });

          console.log("📤 Status message created as reply to original message");

          try {
            await client.invoke(
              new Api.messages.DeleteMessages({
                id: [msgId],
                revoke: true,
              })
            );
            console.log("✅ Quality selector deleted");
          } catch (e) {
            console.error("❌ Failed to delete quality selector:", e.message);
          }

          try {
            if (qualityType === "mp3") {
              await downloadMP3(url, chatId, originalMessageId, statusMessage);
            } else {
              await downloadVideo(
                url,
                chatId,
                originalMessageId,
                qualityType,
                statusMessage
              );
            }
          } catch (error) {
            let errorMessage = "❌ Error: ";

            if (
              error.message.includes("bot") ||
              error.message.includes("Sign in")
            ) {
              errorMessage += "YouTube bot detection!\n\n";
              errorMessage += "Solution: Add cookies.txt file\n";
              errorMessage += "Type /help for instructions";
            } else if (error.message.includes("410")) {
              errorMessage += "Video not available or age-restricted";
            } else if (error.message.includes("Private video")) {
              errorMessage += "This is a private video";
            } else if (error.message.includes("copyright")) {
              errorMessage += "Video blocked due to copyright";
            } else {
              errorMessage += error.message;
            }

            await statusMessage.edit({ text: errorMessage });
          } finally {
            activeDownloads.delete(chatIdStr);
          }
        }
      }
    } catch (error) {
      console.error("❌ Callback error:", error.message);
    }
  });

  console.log("🎬 Bot is listening for messages...");
  console.log("✅ Ready to receive YouTube links!\n");
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Bot stopping...");

  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    files.forEach((file) => {
      try {
        fs.unlinkSync(path.join(tempDir, file));
      } catch (e) {}
    });
  }

  await client.disconnect();
  process.exit(0);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Unhandled rejection:", error.message);
});

app.get("/", (req, res) => {
  const cookieStatus = hasCookies ? "✅ Active" : "❌ Missing";
  res.send(`
    <h1>✅ YouTube Downloader Bot Running</h1>
    <p>📊 Active Downloads: ${activeDownloads.size}</p>
    <p>💾 Cached URLs: ${urlCache.size}</p>
    <p>📝 Cached Playlists: ${playlistCache.size}</p>
    <p>🍪 Cookies Status: ${cookieStatus}</p>
  `);
});

app.listen(PORT, () => {
  console.log(`✅ Express server running on port ${PORT}`);
});
