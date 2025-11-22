import express from "express";
import channelRoutes from "./routes.js"; // Aapka diya hua code

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.use("/api", channelRoutes);

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "active",
    message: "YouTube Channel API",
    endpoints: {
      playlists: "/api/channel/playlists?channel=@channelname",
      playlistInfo: "/api/playlist/info?listid=PLxxx",
      allVideos: "/api/channel?channel=@channelname",
      videoRange: "/api/channel/range?channel=@channelname&start=1&end=50",
      channelInfo: "/api/channel/info?channel=@channelname"
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
});
