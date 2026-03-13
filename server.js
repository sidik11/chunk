const express = require("express");
const Mega = require("megajs");
const cors = require("cors");

const app = express();

// Enhanced CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range', 'Accept'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ";

let videos = [];
let ready = false;
let lastLoadAttempt = 0;
let loadError = null;

// Analytics
let views = {};
let progress = {};
let history = [];

// Clean old history (keep last 100 entries)
setInterval(() => {
  if (history.length > 100) {
    history = history.slice(-100);
  }
}, 3600000);

// Load MEGA folder with retry logic
function loadFolder() {
  const now = Date.now();
  if (now - lastLoadAttempt < 10000 && !ready) return; // Don't retry too often
  
  lastLoadAttempt = now;
  loadError = null;
  
  console.log("Loading MEGA folder...");
  
  try {
    const folder = Mega.File.fromURL(folderURL);
    
    folder.loadAttributes((err) => {
      if (err) {
        console.error("MEGA error:", err.message);
        loadError = err.message;
        ready = false;
        return;
      }

      const files = folder.children || [];
      
      videos = files
        .filter(f => f && f.name && f.size && /\.(mp4|mkv|webm|mov|avi)$/i.test(f.name))
        .map((f, i) => ({
          id: i,
          name: f.name,
          size: f.size,
          file: f,
          type: f.name.split('.').pop().toLowerCase()
        }));

      ready = true;
      loadError = null;
      console.log(`✅ Loaded ${videos.length} videos`);

      // Initialize view counts for new videos
      videos.forEach(v => {
        if (!views[v.id]) views[v.id] = 0;
      });
    });
  } catch (error) {
    console.error("Folder parsing error:", error);
    loadError = error.message;
    ready = false;
  }
}

// Initial load
loadFolder();

// Refresh every 5 minutes
setInterval(loadFolder, 300000);

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    videos: videos.length,
    ready: ready,
    error: loadError,
    uptime: process.uptime()
  });
});

// Get video list with views
app.get("/list", (req, res) => {
  if (!ready) {
    return res.json({ 
      status: "loading", 
      message: "Server is loading videos",
      videos: [] 
    });
  }

  const videoList = videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    type: v.type,
    views: views[v.id] || 0
  }));

  res.json(videoList);
});

// Search videos
app.get("/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  
  if (!q) {
    return res.json([]);
  }

  const results = videos.filter(v =>
    v.name.toLowerCase().includes(q)
  ).map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    type: v.type
  }));

  res.json(results);
});

// Recent videos
app.get("/recent", (req, res) => {
  const recent = [...videos]
    .slice(-20)
    .reverse()
    .map(v => ({
      id: v.id,
      name: v.name,
      size: v.size,
      type: v.type
    }));

  res.json(recent);
});

// Popular videos
app.get("/popular", (req, res) => {
  const popular = [...videos]
    .sort((a, b) => (views[b.id] || 0) - (views[a.id] || 0))
    .slice(0, 20)
    .map(v => ({
      id: v.id,
      name: v.name,
      size: v.size,
      type: v.type,
      views: views[v.id] || 0
    }));

  res.json(popular);
});

// Watch history
app.get("/history", (req, res) => {
  res.json(history.slice(-20).reverse());
});

// Save playback progress
app.post("/progress", (req, res) => {
  const { videoId, time } = req.body;
  
  if (videoId !== undefined && time !== undefined) {
    progress[videoId] = Math.max(0, parseFloat(time) || 0);
    res.json({ status: "saved", videoId, time });
  } else {
    res.status(400).json({ error: "Missing videoId or time" });
  }
});

// Get playback progress
app.get("/progress/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const savedTime = progress[id] || 0;
  res.json({ time: savedTime });
});

// Get video info
app.get("/info/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);
  
  if (!video) {
    return res.status(404).json({ error: "Video not found" });
  }

  res.json({
    id: video.id,
    name: video.name,
    size: video.size,
    type: video.type,
    views: views[video.id] || 0
  });
});

// Video streaming endpoint with proper headers
app.get("/video/:id", (req, res) => {
  if (!ready) {
    return res.status(503).json({ error: "Server loading videos" });
  }

  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);

  if (!video) {
    return res.status(404).json({ error: "Video not found" });
  }

  // Track view (only count unique plays)
  views[id] = (views[id] || 0) + 1;

  // Add to history
  history.push({
    id: id,
    name: video.name,
    time: Date.now()
  });

  const file = video.file;
  const fileSize = video.size;
  const range = req.headers.range;

  // Set proper content type based on file extension
  const ext = video.type;
  let contentType = 'video/mp4';
  if (ext === 'mkv') contentType = 'video/x-matroska';
  else if (ext === 'webm') contentType = 'video/webm';
  else if (ext === 'mov') contentType = 'video/quicktime';
  else if (ext === 'avi') contentType = 'video/x-msvideo';

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    return res.status(204).end();
  }

  // If no range header, send full video
  if (!range) {
    console.log(`Serving full video: ${video.name}`);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileSize,
    });

    const stream = file.download();
    stream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    
    stream.pipe(res);
    return;
  }

  // Parse range header
  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  // Validate range
  if (start >= fileSize || end >= fileSize) {
    res.writeHead(416, {
      'Content-Range': `bytes */${fileSize}`
    });
    return res.end();
  }

  const chunkSize = (end - start) + 1;

  console.log(`Streaming ${video.name}: bytes ${start}-${end}/${fileSize}`);

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': contentType,
  });

  try {
    const stream = file.download({ start, end });
    
    stream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Streaming failed' });
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Folder URL: ${folderURL}`);
});