const express = require("express");
const Mega = require("megajs");
const cors = require("cors");

const app = express();

// Basic CORS
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ";

let videos = [];
let ready = false;

// Load MEGA folder
function loadFolder() {
  console.log("Loading MEGA folder...");
  
  try {
    const folder = Mega.File.fromURL(folderURL);
    
    folder.loadAttributes((err) => {
      if (err) {
        console.error("MEGA error:", err.message);
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
    });
  } catch (error) {
    console.error("Error:", error);
    ready = false;
  }
}

loadFolder();
setInterval(loadFolder, 300000); // Refresh every 5 minutes

// Status endpoint
app.get("/", (req, res) => {
  res.json({ status: "online", videos: videos.length, ready });
});

// Video list
app.get("/list", (req, res) => {
  if (!ready) return res.json([]);
  
  res.json(videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size
  })));
});

// Video streaming - SIMPLIFIED
app.get("/video/:id", (req, res) => {
  if (!ready) {
    return res.status(503).send("Server loading");
  }

  const id = parseInt(req.params.id);
  const video = videos.find(v => v.id === id);

  if (!video) {
    return res.status(404).send("Video not found");
  }

  const file = video.file;
  const fileSize = video.size;
  const range = req.headers.range;

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // No range - send full video
  if (!range) {
    console.log(`Serving: ${video.name}`);
    res.setHeader('Content-Length', fileSize);
    
    const stream = file.download();
    stream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    
    return stream.pipe(res);
  }

  // Parse range
  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = (end - start) + 1;

  console.log(`Range: ${start}-${end}/${fileSize}`);

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Content-Length': chunkSize,
    'Content-Type': 'video/mp4',
  });

  const stream = file.download({ start, end });
  stream.on('error', (err) => {
    console.error('Stream error:', err);
    res.end();
  });
  
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});