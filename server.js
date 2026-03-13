const express = require("express");
const Mega = require("megajs");
const cors = require("cors");

const app = express();

// Allow all CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ";

let videos = [];
let ready = false;
let lastError = null;

function loadFolder() {
  console.log("Loading MEGA folder...");
  
  try {
    const folder = Mega.File.fromURL(folderURL);
    
    folder.loadAttributes((err) => {
      if (err) {
        console.error("MEGA error:", err);
        lastError = err.message;
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
      lastError = null;
      console.log(`✅ Loaded ${videos.length} videos`);
    });
  } catch (error) {
    console.error("Error:", error);
    lastError = error.message;
    ready = false;
  }
}

loadFolder();
setInterval(loadFolder, 300000);

// Status endpoint with debug info
app.get("/", (req, res) => {
  res.json({ 
    status: "online", 
    videos: videos.length, 
    ready,
    error: lastError
  });
});

// Video list
app.get("/list", (req, res) => {
  if (!ready) {
    return res.json({ 
      error: "Server not ready", 
      message: lastError || "Loading videos..." 
    });
  }
  
  res.json(videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size
  })));
});

// Debug endpoint to test video access
app.get("/test/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);
  
  if (!video) {
    return res.json({ error: "Video not found" });
  }

  res.json({
    id: video.id,
    name: video.name,
    size: video.size,
    exists: true
  });
});

// Video streaming
app.get("/video/:id", (req, res) => {
  console.log(`Video request for ID: ${req.params.id}`);
  
  if (!ready) {
    console.log("Server not ready");
    return res.status(503).json({ error: "Server loading" });
  }

  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);

  if (!video) {
    console.log(`Video ${id} not found`);
    return res.status(404).json({ error: "Video not found" });
  }

  console.log(`Found video: ${video.name}, size: ${video.size}`);

  const file = video.file;
  const fileSize = video.size;
  const range = req.headers.range;

  // Set headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Content-Type');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // If no range, send full file
  if (!range) {
    console.log(`Sending full video: ${video.name}`);
    res.setHeader('Content-Length', fileSize);
    
    try {
      const stream = file.download();
      
      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).send('Stream error');
        }
      });

      stream.on('end', () => {
        console.log(`Finished sending: ${video.name}`);
      });

      stream.pipe(res);
    } catch (err) {
      console.error('Download error:', err);
      res.status(500).send('Download failed');
    }
    return;
  }

  // Parse range
  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = (end - start) + 1;

  console.log(`Range request: ${start}-${end}/${fileSize}`);

  // Validate range
  if (start >= fileSize || end >= fileSize) {
    console.log(`Invalid range: ${start}-${end}/${fileSize}`);
    res.writeHead(416, {
      'Content-Range': `bytes */${fileSize}`
    });
    return res.end();
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
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

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Test: http://localhost:${PORT}`);
});