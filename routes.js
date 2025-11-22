import youtubedl from "youtube-dl-exec";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);

// ✅ CORRECTED: Proper yt-dlp options for channel/playlist extraction
function getYtDlpOptions(isFlat = true) {
  const options = {
    skipDownload: true,
    noCheckCertificates: true,
    noWarnings: true,
    ignoreErrors: true,
  };

  if (isFlat) {
    // For getting list of videos (flat extraction)
    options.flatPlaylist = true;
    options.dumpSingleJson = true;
  }

  if (hasCookies) {
    options.cookies = cookiesPath;
  }

  return options;
}

// Helper to parse channel URL
function parseChannelInput(channelParam) {
  if (channelParam.includes("youtube.com")) {
    if (!channelParam.includes("/videos")) {
      if (channelParam.endsWith("/")) {
        return channelParam + "videos";
      }
      return channelParam + "/videos";
    }
    return channelParam;
  }

  if (channelParam.startsWith("@")) {
    return `https://www.youtube.com/${channelParam}/videos`;
  }

  return `https://www.youtube.com/@${channelParam}/videos`;
}

// ✅ Helper to parse channel URL for playlists
function parseChannelInputForPlaylists(channelParam) {
  if (channelParam.includes("youtube.com")) {
    // Remove /videos or /playlists if present
    let cleanUrl = channelParam.replace(/\/(videos|playlists)\/?$/, "");
    if (cleanUrl.endsWith("/")) {
      return cleanUrl + "playlists";
    }
    return cleanUrl + "/playlists";
  }

  if (channelParam.startsWith("@")) {
    return `https://www.youtube.com/${channelParam}/playlists`;
  }

  return `https://www.youtube.com/@${channelParam}/playlists`;
}

// ✅ Fetch channel videos in batches
async function fetchChannelInBatches(channelUrl) {
  const batchSize = 100;
  let allVideos = [];
  let currentBatch = 1;
  let hasMore = true;

  console.log(`📊 Starting batch fetch from channel...`);

  while (hasMore) {
    try {
      const startIndex = (currentBatch - 1) * batchSize + 1;
      const endIndex = currentBatch * batchSize;

      console.log(
        `📦 Fetching batch ${currentBatch}: videos ${startIndex}-${endIndex}`
      );

      const options = {
        ...getYtDlpOptions(true),
        playlistStart: startIndex,
        playlistEnd: endIndex,
      };

      const batchData = await youtubedl(channelUrl, options);

      // Check if we got any data
      if (!batchData) {
        console.log(`⚠️ No data returned for batch ${currentBatch}`);
        hasMore = false;
        break;
      }

      // Handle both single video and playlist responses
      let entries = [];

      if (batchData.entries && Array.isArray(batchData.entries)) {
        entries = batchData.entries;
      } else if (batchData._type === "playlist" && batchData.entries) {
        entries = batchData.entries;
      } else {
        console.log(`⚠️ Unexpected data format in batch ${currentBatch}`);
        hasMore = false;
        break;
      }

      if (entries.length === 0) {
        console.log(
          `✅ No more videos found. Total batches: ${currentBatch - 1}`
        );
        hasMore = false;
        break;
      }

      const batchVideos = entries
        .filter((entry) => entry && entry.id)
        .map((entry) => ({
          id: entry.id,
          url: `https://www.youtube.com/watch?v=${entry.id}`,
          title: entry.title || "Unknown",
        }));

      allVideos.push(...batchVideos);

      console.log(
        `✅ Batch ${currentBatch} fetched: ${batchVideos.length} videos (Total so far: ${allVideos.length})`
      );

      // If we got less than batchSize, we've reached the end
      if (batchVideos.length < batchSize) {
        console.log(
          `✅ Reached end of channel. Total videos: ${allVideos.length}`
        );
        hasMore = false;
      } else {
        currentBatch++;
        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`❌ Error in batch ${currentBatch}:`, error.message);

      // If it's a "no more videos" error, stop gracefully
      if (
        error.message.includes("no videos") ||
        error.message.includes("Playlist does not") ||
        currentBatch > 1
      ) {
        console.log(
          `✅ Reached end of available videos. Total: ${allVideos.length}`
        );
        hasMore = false;
      } else {
        throw error;
      }
    }
  }

  return allVideos;
}

// ✅ NEW: Fetch just playlist IDs (FAST - no details)
async function fetchChannelPlaylistIds(channelUrl) {
  console.log(`📋 Fetching playlist IDs from channel (fast mode)...`);

  try {
    const options = {
      ...getYtDlpOptions(true),
      ignoreErrors: true,
    };

    const playlistsData = await youtubedl(channelUrl, options);

    if (!playlistsData) {
      console.log(`⚠️ No playlist data returned`);
      return [];
    }

    let entries = [];

    if (playlistsData.entries && Array.isArray(playlistsData.entries)) {
      entries = playlistsData.entries;
    } else if (playlistsData._type === "playlist" && playlistsData.entries) {
      entries = playlistsData.entries;
    }

    console.log(`📋 Found ${entries.length} playlists`);

    // Extract only IDs (super fast)
    const playlistIds = entries
      .filter((entry) => entry && entry.id)
      .map((entry) => entry.id);

    console.log(`✅ Extracted ${playlistIds.length} playlist IDs`);
    return playlistIds;
  } catch (error) {
    console.error("❌ Error fetching playlist IDs:", error.message);
    throw error;
  }
}

// ✅ NEW: Fetch single playlist details
async function fetchPlaylistDetails(playlistId) {
  console.log(`🔍 Fetching details for playlist: ${playlistId}`);

  try {
    const playlistUrl = playlistId.includes("youtube.com")
      ? playlistId
      : `https://www.youtube.com/playlist?list=${playlistId}`;

    const options = {
      ...getYtDlpOptions(true),
      playlistEnd: 1, // Just get first video to get playlist info
    };

    const playlistInfo = await youtubedl(playlistUrl, options);

    if (!playlistInfo) {
      throw new Error("No playlist data returned");
    }

    const videoCount =
      playlistInfo.playlist_count ||
      (playlistInfo.entries ? playlistInfo.entries.length : 0) ||
      0;

    const thumbnail =
      playlistInfo.thumbnail ||
      playlistInfo.thumbnails?.[0]?.url ||
      (playlistInfo.entries && playlistInfo.entries[0]
        ? playlistInfo.entries[0].thumbnail
        : null);

    return {
      playlistId: playlistInfo.id || playlistId,
      title: playlistInfo.title || "Unknown Playlist",
      totalVideos: videoCount,
      thumbnail: thumbnail,
      url: playlistUrl,
    };
  } catch (error) {
    console.error(`❌ Error fetching playlist details:`, error.message);
    throw error;
  }
}

// ✅ NEW API Route: GET /api/channel/playlists (FAST - just IDs and count)
router.get("/channel/playlists", async (req, res) => {
  try {
    const channelParam = req.query.channel;

    if (!channelParam) {
      return res.status(400).json({
        success: false,
        error: "Missing channel parameter",
        usage: {
          examples: [
            "/api/channel/playlists?channel=@bigmagic",
            "/api/channel/playlists?channel=bigmagic",
            "/api/channel/playlists?channel=https://www.youtube.com/@bigmagic",
          ],
        },
      });
    }

    console.log("🔍 Fetching playlist IDs for channel:", channelParam);

    const channelUrl = parseChannelInputForPlaylists(channelParam);
    console.log("📺 Channel Playlists URL:", channelUrl);

    let playlistIds;
    let channelInfo = {
      name: "Unknown",
      id: "Unknown",
      url: channelUrl.replace("/playlists", ""),
    };

    try {
      playlistIds = await fetchChannelPlaylistIds(channelUrl);

      // Get channel info from first playlist if available
      if (playlistIds.length > 0) {
        try {
          const firstPlaylistUrl = `https://www.youtube.com/playlist?list=${playlistIds[0]}`;
          const playlistData = await youtubedl(firstPlaylistUrl, {
            dumpSingleJson: true,
            skipDownload: true,
            playlistEnd: 1,
            cookies: hasCookies ? cookiesPath : undefined,
          });

          channelInfo = {
            name: playlistData.channel || playlistData.uploader || "Unknown",
            id:
              playlistData.channel_id || playlistData.uploader_id || "Unknown",
            url: channelUrl.replace("/playlists", ""),
          };
        } catch (error) {
          console.log("⚠️ Could not fetch channel info:", error.message);
        }
      }
    } catch (error) {
      console.error("❌ Fetch error:", error.message);

      if (error.message.includes("Sign in") || error.message.includes("bot")) {
        return res.status(403).json({
          success: false,
          error: "YouTube bot detection",
          details:
            "Cookies required. Please add cookies.txt file to the project root.",
          solution:
            "Export cookies from youtube.com using a browser extension",
        });
      } else if (
        error.message.includes("not found") ||
        error.message.includes("404") ||
        error.message.includes("does not exist")
      ) {
        return res.status(404).json({
          success: false,
          error: "Channel not found",
          details: `No channel found for: ${channelParam}`,
          suggestion: "Check the channel name or URL",
        });
      } else if (error.message.includes("429")) {
        return res.status(429).json({
          success: false,
          error: "Rate limited",
          details: "Too many requests. Please try again later.",
        });
      }

      throw error;
    }

    if (playlistIds.length === 0) {
      return res.json({
        success: true,
        channel: channelInfo,
        totalPlaylists: 0,
        playlists: [],
        message: "No playlists found in this channel",
      });
    }

    console.log(`✅ Total playlists found: ${playlistIds.length}`);

    return res.json({
      success: true,
      channel: channelInfo,
      totalPlaylists: playlistIds.length,
      playlists: playlistIds,
    });
  } catch (error) {
    console.error("❌ API Error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

// ✅ NEW API Route: GET /api/playlist/info (get single playlist details)
router.get("/playlist/info", async (req, res) => {
  try {
    const playlistId = req.query.listid;

    if (!playlistId) {
      return res.status(400).json({
        success: false,
        error: "Missing listid parameter",
        usage: {
          examples: [
            "/api/playlist/info?listid=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
            "/api/playlist/info?listid=https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
          ],
        },
      });
    }

    console.log("🔍 Fetching playlist details for:", playlistId);

    let playlistDetails;

    try {
      playlistDetails = await fetchPlaylistDetails(playlistId);
    } catch (error) {
      console.error("❌ Fetch error:", error.message);

      if (error.message.includes("Sign in") || error.message.includes("bot")) {
        return res.status(403).json({
          success: false,
          error: "YouTube bot detection",
          details: "Cookies required. Please add cookies.txt file.",
          solution: "Export cookies from youtube.com using a browser extension",
        });
      } else if (
        error.message.includes("not found") ||
        error.message.includes("404") ||
        error.message.includes("does not exist")
      ) {
        return res.status(404).json({
          success: false,
          error: "Playlist not found",
          details: `No playlist found for: ${playlistId}`,
          suggestion: "Check the playlist ID or URL",
        });
      } else if (error.message.includes("429")) {
        return res.status(429).json({
          success: false,
          error: "Rate limited",
          details: "Too many requests. Please try again later.",
        });
      }

      throw error;
    }

    console.log(`✅ Playlist details fetched successfully`);

    return res.json({
      success: true,
      playlist: playlistDetails,
    });
  } catch (error) {
    console.error("❌ API Error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

// ✅ API Route: GET /api/channel (fetches ALL videos in batches)
router.get("/channel", async (req, res) => {
  try {
    const channelParam = req.query.channel;

    if (!channelParam) {
      return res.status(400).json({
        success: false,
        error: "Missing channel parameter",
        usage: {
          examples: [
            "/api/channel?channel=@TED",
            "/api/channel?channel=TED",
            "/api/channel?channel=https://www.youtube.com/@TED/videos",
          ],
        },
      });
    }

    console.log("🔍 Fetching channel videos for:", channelParam);

    const channelUrl = parseChannelInput(channelParam);
    console.log("📺 Channel URL:", channelUrl);

    // ✅ Fetch all videos in batches
    let allVideos;
    let channelInfo = {
      name: "Unknown",
      id: "Unknown",
      url: channelUrl,
    };

    try {
      allVideos = await fetchChannelInBatches(channelUrl);

      // Get channel info from first video if available
      if (allVideos.length > 0) {
        try {
          const firstVideoUrl = allVideos[0].url;
          const videoInfo = await youtubedl(firstVideoUrl, {
            dumpSingleJson: true,
            skipDownload: true,
            cookies: hasCookies ? cookiesPath : undefined,
          });

          channelInfo = {
            name: videoInfo.channel || videoInfo.uploader || "Unknown",
            id: videoInfo.channel_id || videoInfo.uploader_id || "Unknown",
            url: channelUrl,
          };
        } catch (error) {
          console.log("⚠️ Could not fetch channel info:", error.message);
        }
      }
    } catch (error) {
      console.error("❌ Fetch error:", error.message);

      if (error.message.includes("Sign in") || error.message.includes("bot")) {
        return res.status(403).json({
          success: false,
          error: "YouTube bot detection",
          details:
            "Cookies required. Please add cookies.txt file to the project root.",
          solution:
            "Export cookies from youtube.com using a browser extension",
        });
      } else if (
        error.message.includes("not found") ||
        error.message.includes("404") ||
        error.message.includes("does not exist")
      ) {
        return res.status(404).json({
          success: false,
          error: "Channel not found",
          details: `No channel found for: ${channelParam}`,
          suggestion: "Check the channel name or URL",
        });
      } else if (error.message.includes("429")) {
        return res.status(429).json({
          success: false,
          error: "Rate limited",
          details: "Too many requests. Please try again later.",
        });
      }

      throw error;
    }

    if (allVideos.length === 0) {
      return res.json({
        success: true,
        channel: channelInfo,
        total: 0,
        urls: [],
        message: "No videos found in this channel",
      });
    }

    const videoUrls = allVideos.map((v) => v.url);

    console.log(`✅ Total videos fetched: ${videoUrls.length}`);

    return res.json({
      success: true,
      channel: channelInfo,
      total: videoUrls.length,
      urls: videoUrls,
    });
  } catch (error) {
    console.error("❌ API Error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

// ✅ API Route: GET /api/channel/range (fetch specific range - FAST)
router.get("/channel/range", async (req, res) => {
  try {
    const channelParam = req.query.channel;
    const start = parseInt(req.query.start) || 1;
    const end = parseInt(req.query.end) || 50;

    if (!channelParam) {
      return res.status(400).json({
        success: false,
        error: "Missing channel parameter",
        usage: {
          examples: [
            "/api/channel/range?channel=@TED&start=1&end=50",
            "/api/channel/range?channel=@TED&start=51&end=100",
          ],
        },
      });
    }

    if (start < 1 || end < start) {
      return res.status(400).json({
        success: false,
        error: "Invalid range",
        details: "start must be >= 1 and end must be >= start",
      });
    }

    console.log(
      `🔍 Fetching channel videos (Range: ${start}-${end}):`,
      channelParam
    );

    const channelUrl = parseChannelInput(channelParam);

    const options = {
      ...getYtDlpOptions(true),
      playlistStart: start,
      playlistEnd: end,
    };

    let channelData;

    try {
      channelData = await youtubedl(channelUrl, options);
    } catch (error) {
      console.error("❌ yt-dlp error:", error.message);

      if (error.message.includes("Sign in") || error.message.includes("bot")) {
        return res.status(403).json({
          success: false,
          error: "YouTube bot detection",
          details: "Cookies required. Add cookies.txt file.",
        });
      } else if (
        error.message.includes("not found") ||
        error.message.includes("404")
      ) {
        return res.status(404).json({
          success: false,
          error: "Channel not found",
          details: `No channel found for: ${channelParam}`,
        });
      }

      throw error;
    }

    const entries = channelData.entries || [];

    const videos = entries
      .filter((entry) => entry && entry.id)
      .map((entry) => ({
        id: entry.id,
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        title: entry.title || "Unknown",
      }));

    // Get channel info
    let channelInfo = {
      name: "Unknown",
      id: "Unknown",
      url: channelUrl,
    };

    if (videos.length > 0) {
      try {
        const videoInfo = await youtubedl(videos[0].url, {
          dumpSingleJson: true,
          skipDownload: true,
          cookies: hasCookies ? cookiesPath : undefined,
        });

        channelInfo = {
          name: videoInfo.channel || videoInfo.uploader || "Unknown",
          id: videoInfo.channel_id || videoInfo.uploader_id || "Unknown",
          url: channelUrl,
        };
      } catch (error) {
        console.log("⚠️ Could not fetch channel info");
      }
    }

    return res.json({
      success: true,
      channel: channelInfo,
      range: {
        start: start,
        end: end,
        returned: videos.length,
      },
      total: videos.length,
      urls: videos.map((v) => v.url),
    });
  } catch (error) {
    console.error("❌ API Error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

// ✅ API Route: GET /api/channel/info (just channel info)
router.get("/channel/info", async (req, res) => {
  try {
    const channelParam = req.query.channel;

    if (!channelParam) {
      return res.status(400).json({
        success: false,
        error: "Missing channel parameter",
      });
    }

    const channelUrl = parseChannelInput(channelParam);

    const options = {
      ...getYtDlpOptions(true),
      playlistEnd: 1,
    };

    const channelData = await youtubedl(channelUrl, options);

    // Get first video to extract channel info
    let channelInfo = {
      name: "Unknown",
      id: "Unknown",
      url: channelUrl,
    };

    if (channelData.entries && channelData.entries.length > 0) {
      const firstVideoUrl = `https://www.youtube.com/watch?v=${channelData.entries[0].id}`;

      const videoInfo = await youtubedl(firstVideoUrl, {
        dumpSingleJson: true,
        skipDownload: true,
        cookies: hasCookies ? cookiesPath : undefined,
      });

      channelInfo = {
        name: videoInfo.channel || videoInfo.uploader || "Unknown",
        id: videoInfo.channel_id || videoInfo.uploader_id || "Unknown",
        url: channelUrl,
        subscriber_count: videoInfo.channel_follower_count || "Unknown",
      };
    }

    return res.json({
      success: true,
      channel: channelInfo,
    });
  } catch (error) {
    console.error("❌ API Error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

export default router;

// ═══════════════════════════════════════════════════════════════
// 📚 USAGE EXAMPLES:
// ═══════════════════════════════════════════════════════════════

// 1️⃣ Get all playlist IDs from a channel (FAST):
// curl "http://localhost:3000/api/channel/playlists?channel=@bigmagic"
// Response: { totalPlaylists: 172, playlists: ["PLxxx", "PLyyy", ...] }

// 2️⃣ Get details of a specific playlist:
// curl "http://localhost:3000/api/playlist/info?listid=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
// Response: { playlistId, title, totalVideos, thumbnail, url }

// 3️⃣ Get all videos from a channel:
// curl "http://localhost:3000/api/channel?channel=@TED"

// 4️⃣ Get specific range of videos:
// curl "http://localhost:3000/api/channel/range?channel=@TED&start=1&end=50"

// 5️⃣ Get channel info:
// curl "http://localhost:3000/api/channel/info?channel=@TED"
