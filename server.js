const express = require("express");
const Mega = require("megajs");
const cors = require("cors");

const app = express();

// Comprehensive CORS
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

// Analytics (matching frontend expectations)
let views = {};
let progress = {};
let history = [];

// Load MEGA folder
function loadFolder() {
  console.log("Loading MEGA folder...");
  
  try {
    const folder = Mega.File.fromURL(folderURL);
    
    folder.loadAttributes((err) => {
      if (err) {
        console.error("MEGA error:", err);
        ready = false;
        return;
      }

      const files = folder.children || [];
      
      videos = files
        .filter(f => f && f.name && f.size && /\.(mp4|mkv|webm|mov)$/i.test(f.name))
        .map((f, i) => ({
          id: i,
          name: f.name,
          size: f.size,
          file: f
        }));

      ready = true;
      console.log(`✅ Loaded ${videos.length} videos`);
      
      // Initialize view counts
      videos.forEach(v => {
        if (!views[v.id]) views[v.id] = 0;
      });
    });
  } catch (error) {
    console.error("Error:", error);
    ready = false;
  }
}

loadFolder();
setInterval(loadFolder, 60000); // Refresh every minute

// ============= ENDPOINTS MATCHING YOUR FRONTEND =============

// Server status (root)
app.get("/", (req, res) => {
  res.send("Mega streaming server running");
});

// Video list with views
app.get("/list", (req, res) => {
  if (!ready) return res.json([]);
  
  res.json(videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    views: views[v.id] || 0
  })));
});

// Search videos
app.get("/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  
  const results = videos.filter(v =>
    v.name.toLowerCase().includes(q)
  );
  
  res.json(results.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size
  })));
});

// Recent videos (last 10)
app.get("/recent", (req, res) => {
  const recent = [...videos].slice(-10).reverse();
  
  res.json(recent.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size
  })));
});

// Popular videos (most viewed)
app.get("/popular", (req, res) => {
  const sorted = [...videos].sort((a, b) =>
    (views[b.id] || 0) - (views[a.id] || 0)
  );
  
  res.json(sorted.slice(0, 10).map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    views: views[v.id] || 0
  })));
});

// Watch history (last 20)
app.get("/history", (req, res) => {
  res.json(history.slice(-20).reverse());
});

// Save playback progress
app.post("/progress", (req, res) => {
  const { videoId, time } = req.body;
  
  if (videoId !== undefined) {
    progress[videoId] = time || 0;
    res.json({ status: "saved" });
  } else {
    res.status(400).json({ error: "Missing videoId" });
  }
});

// Get playback progress
app.get("/progress/:id", (req, res) => {
  const id = parseInt(req.params.id);
  res.json({ time: progress[id] || 0 });
});

// VIDEO STREAMING - CRITICAL FIX
app.get("/video/:id", (req, res) => {
  console.log(`🎬 Video request for ID: ${req.params.id}`);
  
  if (!ready) {
    console.log("❌ Server not ready");
    return res.status(503).send("Loading");
  }

  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);

  if (!video) {
    console.log(`❌ Video ${id} not found`);
    return res.status(404).send("Video not found");
  }

  console.log(`✅ Found: ${video.name} (${video.size} bytes)`);

  // Track view
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

  // Set essential headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    return res.status(200).end();
  }

  // No range header - send full video (200 OK)
  if (!range) {
    console.log(`📤 Sending full video: ${video.name}`);
    res.setHeader('Content-Length', fileSize);
    res.status(200);
    
    try {
      const stream = file.download();
      
      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).send('Stream error');
        }
      });

      stream.pipe(res);
    } catch (err) {
      console.error('Download error:', err);
      res.status(500).send('Download failed');
    }
    return;
  }

  // Parse range header (206 Partial Content)
  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = (end - start) + 1;

  console.log(`📤 Range: ${start}-${end}/${fileSize}`);

  // Validate range
  if (start >= fileSize || end >= fileSize) {
    console.log(`❌ Invalid range`);
    res.writeHead(416, {
      'Content-Range': `bytes */${fileSize}`
    });
    return res.end();
  }

  // Send partial content
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': 'video/mp4',
  });

  try {
    const stream = file.download({ start, end });
    
    stream.on('error', (err) => {
      console.error('Stream error:', err);
      res.end();
    });

    stream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.end();
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Endpoint not found');
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Folder: ${folderURL}`);
  console.log(`✅ All endpoints ready: /list, /search, /recent, /popular, /history, /progress, /video/:id`);
});