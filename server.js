const express = require("express");
const Mega = require("megajs");
const cors = require("cors");
const https = require('https');

const app = express();

// Aggressive CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Range', 'Content-Type', 'Accept'],
  exposedHeaders: ['Content-Range', 'Content-Length', 'Content-Type', 'Accept-Ranges']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ";

let videos = [];
let ready = false;

// Increase HTTPS agent timeout
const agent = new https.Agent({
  keepAlive: true,
  timeout: 60000,
  maxSockets: 10
});

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
          file: f,
          // Determine content type
          contentType: f.name.toLowerCase().endsWith('.mp4') ? 'video/mp4' :
                      f.name.toLowerCase().endsWith('.webm') ? 'video/webm' :
                      f.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' :
                      f.name.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4'
        }));

      ready = true;
      console.log(`✅ Loaded ${videos.length} videos`);
      videos.forEach(v => console.log(`  ${v.id}: ${v.name} (${v.contentType})`));
    });
  } catch (error) {
    console.error("Error:", error);
    ready = false;
  }
}

loadFolder();
setInterval(loadFolder, 300000);

// Status
app.get("/", (req, res) => {
  res.json({ 
    status: "online", 
    videos: videos.length, 
    ready,
    version: "2.0"
  });
});

// List videos
app.get("/list", (req, res) => {
  if (!ready) return res.json([]);
  
  res.json(videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    type: v.contentType
  })));
});

// Direct download URL (alternative approach)
app.get("/direct/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);
  
  if (!video) {
    return res.status(404).json({ error: "Video not found" });
  }

  // Get direct download link from MEGA
  video.file.link((err, url) => {
    if (err) {
      return res.status(500).json({ error: "Failed to get download link" });
    }
    res.json({ url });
  });
});

// Video streaming - SIMPLIFIED
app.get("/video/:id", (req, res) => {
  console.log(`📺 Request for video ID: ${req.params.id}`);
  
  if (!ready) {
    console.log("❌ Server not ready");
    return res.status(503).send("Server loading");
  }

  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);

  if (!video) {
    console.log(`❌ Video ${id} not found`);
    return res.status(404).send("Video not found");
  }

  console.log(`✅ Found: ${video.name} (${video.size} bytes)`);

  const file = video.file;
  const fileSize = video.size;
  const range = req.headers.range;

  // Set headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Content-Type, Accept-Ranges');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', video.contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(video.name)}"`);

  // Handle OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // No range - send full file with 200
  if (!range) {
    console.log(`📤 Sending full file: ${video.name}`);
    res.setHeader('Content-Length', fileSize);
    res.status(200);
    
    try {
      const stream = file.download({ agent });
      
      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).send('Stream error');
        }
      });

      stream.on('end', () => {
        console.log(`✅ Finished: ${video.name}`);
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
    'Content-Length': chunkSize,
    'Content-Type': video.contentType,
  });

  try {
    const stream = file.download({ start, end, agent });
    
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
  console.log(`🌍 CORS enabled for all origins`);
});