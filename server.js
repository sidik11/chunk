const express = require("express")
const Mega = require("megajs")
const cors = require("cors")
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const crypto = require('crypto')

const app = express()

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000

const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ"

let videos = []
let ready = false
let megaFolder = null

// Create thumbnails directory
const THUMB_DIR = path.join(__dirname, 'thumbnails');
if (!fs.existsSync(THUMB_DIR)) {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  console.log('✅ Created thumbnails directory');
}

// analytics
let views = {}
let progress = {}
let history = {}

// Helper function to format bytes
function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const mb = bytes / 1024 / 1024
  return mb.toFixed(2) + ' MB'
}

// Get MIME type based on file extension
function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  const mimeTypes = {
    'mp4': 'video/mp4',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'm4v': 'video/x-m4v'
  }
  return mimeTypes[ext] || 'video/mp4'
}

// Generate thumbnail at 10 seconds
async function generateThumbnail(videoId, videoFile, videoName) {
  return new Promise((resolve, reject) => {
    const thumbPath = path.join(THUMB_DIR, `${videoId}.jpg`);
    const tempVideoPath = path.join(THUMB_DIR, `temp_${videoId}_${Date.now()}.mp4`);
    
    console.log(`🎬 Generating thumbnail for video ${videoId}: ${videoName}`);
    
    // Download first 2MB of video (enough for thumbnail generation)
    const stream = videoFile.download({ start: 0, end: 2 * 1024 * 1024 }); // First 2MB
    const fileStream = fs.createWriteStream(tempVideoPath);
    
    stream.pipe(fileStream);
    
    stream.on('end', () => {
      // Use ffmpeg to generate thumbnail at 10 seconds
      // Scale to 320x180 for optimal thumbnail size
      exec(
        `ffmpeg -i "${tempVideoPath}" -ss 00:00:10 -vframes 1 -vf "scale=320:180" "${thumbPath}" -y -loglevel error`,
        (error, stdout, stderr) => {
          // Clean up temp file
          fs.unlink(tempVideoPath, (err) => {
            if (err) console.error('Error deleting temp file:', err);
          });
          
          if (error) {
            console.error(`❌ Thumbnail generation failed for ${videoName}:`, error.message);
            reject(error);
          } else {
            console.log(`✅ Thumbnail generated for ${videoName}`);
            resolve(thumbPath);
          }
        }
      );
    });
    
    stream.on('error', (err) => {
      console.error(`❌ Download error for ${videoName}:`, err);
      // Clean up temp file on error
      fs.unlink(tempVideoPath, () => {});
      reject(err);
    });
  });
}

// Generate thumbnails for all videos
async function generateAllThumbnails() {
  console.log('\n🎬 Starting thumbnail generation for all videos...');
  
  for (const video of videos) {
    const thumbPath = path.join(THUMB_DIR, `${video.id}.jpg`);
    
    // Skip if thumbnail already exists
    if (fs.existsSync(thumbPath)) {
      console.log(`⏭️ Thumbnail already exists for ${video.name}`);
      continue;
    }
    
    try {
      await generateThumbnail(video.id, video.file, video.name);
      // Small delay to avoid overwhelming MEGA
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`❌ Failed to generate thumbnail for ${video.name}`);
    }
  }
  
  console.log('✅ Thumbnail generation complete!\n');
}

// load MEGA folder
function loadFolder() {
  console.log("\n📂 Loading MEGA folder...")
  
  const folder = Mega.File.fromURL(folderURL)
  
  folder.loadAttributes(err => {
    if (err) {
      console.log("❌ MEGA error:", err)
      return
    }
    
    megaFolder = folder
    const files = folder.children || []
    
    const newVideos = files
      .filter(f => f && f.name && f.size && /\.(mp4|mkv|webm|mov|avi|m4v)$/i.test(f.name))
      .map((f, i) => ({
        id: i,
        name: f.name,
        size: f.size,
        file: f,
        mimeType: getMimeType(f.name)
      }))
    
    // Check if videos changed
    const videosChanged = JSON.stringify(videos.map(v => v.id)) !== JSON.stringify(newVideos.map(v => v.id));
    
    videos = newVideos
    ready = true
    
    console.log(`✅ Loaded ${videos.length} videos`)
    
    // Log first few videos
    videos.slice(0, 3).forEach(v => {
      console.log(`   📹 ${v.id}: ${v.name} (${formatBytes(v.size)})`)
    })
    
    // Generate thumbnails if videos changed
    if (videosChanged && videos.length > 0) {
      generateAllThumbnails();
    }
  })
}

// Initial load
loadFolder()

// refresh list every 60 seconds
setInterval(loadFolder, 60000)

// server status
app.get("/", (req, res) => {
  const thumbCount = fs.readdirSync(THUMB_DIR).filter(f => f.endsWith('.jpg')).length;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mega Streaming Server</title>
      <style>
        body { font-family: system-ui; background: #0f172a; color: white; padding: 20px; }
        .status { padding: 20px; border-radius: 10px; margin: 20px 0; }
        .online { background: #10b981; }
        .loading { background: #f59e0b; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px; }
        .stat-card { background: #1e293b; padding: 15px; border-radius: 10px; }
        .stat-value { font-size: 24px; font-weight: bold; color: #60a5fa; }
        .stat-label { color: #94a3b8; font-size: 14px; }
        h1 { color: #60a5fa; }
        a { color: #94a3b8; text-decoration: none; margin-right: 15px; }
        a:hover { color: #60a5fa; }
      </style>
    </head>
    <body>
      <h1>🎬 Mega Streaming Server</h1>
      <div class="status ${ready ? 'online' : 'loading'}">
        Status: ${ready ? '✅ Ready' : '⏳ Loading...'}
      </div>
      
      <div class="stats">
        <div class="stat-card">
          <div class="stat-value">${videos.length}</div>
          <div class="stat-label">Videos Loaded</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${thumbCount}</div>
          <div class="stat-label">Thumbnails Generated</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${Object.keys(views).length}</div>
          <div class="stat-label">Videos Viewed</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</div>
          <div class="stat-label">Memory Used</div>
        </div>
      </div>
      
      <div style="margin-top: 30px;">
        <h3>Endpoints:</h3>
        <a href="/list">📋 /list</a>
        <a href="/debug">🔍 /debug</a>
        <a href="/thumbnails">🖼️ /thumbnails</a>
        <a href="/stats">📊 /stats</a>
      </div>
    </body>
    </html>
  `)
})

// List all thumbnails
app.get("/thumbnails", (req, res) => {
  const thumbs = fs.readdirSync(THUMB_DIR)
    .filter(f => f.endsWith('.jpg'))
    .map(f => ({
      id: f.replace('.jpg', ''),
      path: `/thumbnail/${f.replace('.jpg', '')}`
    }));
  
  res.json(thumbs);
})

// Server stats
app.get("/stats", (req, res) => {
  res.json({
    ready,
    videoCount: videos.length,
    thumbnailCount: fs.readdirSync(THUMB_DIR).filter(f => f.endsWith('.jpg')).length,
    views,
    progress: Object.keys(progress).length,
    history: history.length,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  })
})

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    ready,
    videoCount: videos.length,
    videos: videos.slice(0, 5).map(v => ({
      id: v.id,
      name: v.name,
      size: formatBytes(v.size),
      mimeType: v.mimeType,
      hasThumbnail: fs.existsSync(path.join(THUMB_DIR, `${v.id}.jpg`))
    })),
    views,
    thumbnailDir: fs.existsSync(THUMB_DIR) ? fs.readdirSync(THUMB_DIR).length : 0,
    memory: process.memoryUsage()
  })
})

// video list
app.get("/list", (req, res) => {
  if (!ready) return res.json([])
  
  res.json(videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    mimeType: v.mimeType,
    views: views[v.id] || 0,
    hasThumbnail: fs.existsSync(path.join(THUMB_DIR, `${v.id}.jpg`))
  })))
})

// search videos
app.get("/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase()
  
  const results = videos.filter(v =>
    v.name.toLowerCase().includes(q)
  )
  
  res.json(results.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    mimeType: v.mimeType,
    hasThumbnail: fs.existsSync(path.join(THUMB_DIR, `${v.id}.jpg`))
  })))
})

// recent videos
app.get("/recent", (req, res) => {
  const recent = [...videos].slice(-10).reverse()
  
  res.json(recent.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    mimeType: v.mimeType,
    hasThumbnail: fs.existsSync(path.join(THUMB_DIR, `${v.id}.jpg`))
  })))
})

// popular videos
app.get("/popular", (req, res) => {
  const sorted = [...videos].sort((a, b) =>
    (views[b.id] || 0) - (views[a.id] || 0)
  )
  
  res.json(sorted.slice(0, 10).map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    mimeType: v.mimeType,
    views: views[v.id] || 0,
    hasThumbnail: fs.existsSync(path.join(THUMB_DIR, `${v.id}.jpg`))
  })))
})

// watch history
app.get("/history", (req, res) => {
  res.json(history.slice(-20).reverse())
})

// save playback progress
app.post("/progress", (req, res) => {
  const { videoId, time } = req.body
  if (videoId !== undefined) {
    progress[videoId] = time
  }
  res.json({ status: "saved" })
})

// get playback progress
app.get("/progress/:id", (req, res) => {
  const id = req.params.id
  res.json({ time: progress[id] || 0 })
})

// THUMBNAIL ENDPOINT - Get thumbnail at 10 seconds
app.get("/thumbnail/:id", async (req, res) => {
  const id = parseInt(req.params.id)
  const video = videos.find(v => v.id === id)
  
  if (!video) {
    return res.status(404).json({ error: "Video not found" })
  }
  
  const thumbPath = path.join(THUMB_DIR, `${id}.jpg`)
  
  // Check if thumbnail exists
  if (fs.existsSync(thumbPath)) {
    // Set proper cache headers
    res.setHeader('Cache-Control', 'public, max-age=86400') // Cache for 24 hours
    res.setHeader('Content-Type', 'image/jpeg')
    return res.sendFile(thumbPath)
  }
  
  // Generate thumbnail on demand
  try {
    console.log(`🎬 Generating thumbnail on demand for ${video.name}`)
    await generateThumbnail(id, video.file, video.name)
    
    if (fs.existsSync(thumbPath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.setHeader('Content-Type', 'image/jpeg')
      res.sendFile(thumbPath)
    } else {
      // If generation failed, send a default colored placeholder
      res.setHeader('Content-Type', 'image/svg+xml')
      res.send(`<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">
        <rect width="320" height="180" fill="#1e293b"/>
        <text x="160" y="90" font-family="Arial" font-size="14" fill="#94a3b8" text-anchor="middle">🎬 ${video.name}</text>
        <text x="160" y="120" font-family="Arial" font-size="12" fill="#64748b" text-anchor="middle">00:10</text>
      </svg>`)
    }
  } catch (err) {
    console.error('Thumbnail generation failed:', err)
    // Send a simple colored placeholder
    res.setHeader('Content-Type', 'image/svg+xml')
    res.send(`<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">
      <rect width="320" height="180" fill="#1e293b"/>
      <text x="160" y="90" font-family="Arial" font-size="14" fill="#94a3b8" text-anchor="middle">🎬 ${video.name}</text>
      <text x="160" y="120" font-family="Arial" font-size="12" fill="#ef4444" text-anchor="middle">Thumbnail unavailable</text>
    </svg>`)
  }
})

// Test endpoint
app.get("/test/:id", async (req, res) => {
  const id = parseInt(req.params.id)
  const video = videos.find(v => v.id === id)
  
  if (!video) {
    return res.status(404).json({ error: "Video not found" })
  }
  
  try {
    res.json({
      id: video.id,
      name: video.name,
      size: video.size,
      sizeFormatted: formatBytes(video.size),
      mimeType: video.mimeType,
      ready: ready,
      hasFile: !!video.file,
      hasThumbnail: fs.existsSync(path.join(THUMB_DIR, `${id}.jpg`)),
      fileAttributes: video.file ? Object.keys(video.file) : []
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// video streaming
app.get("/video/:id", async (req, res) => {
  const startTime = Date.now()
  
  try {
    if (!ready) {
      console.log("Server not ready")
      return res.status(503).json({ error: "Server loading" })
    }
    
    const id = parseInt(req.params.id)
    const video = videos.find(v => v.id === id)
    
    if (!video) {
      console.log(`Video ${id} not found`)
      return res.status(404).json({ error: "Video not found" })
    }
    
    console.log(`Streaming: ${video.name} (ID: ${id})`)
    
    // Update analytics
    views[id] = (views[id] || 0) + 1
    history.push({
      id: id,
      name: video.name,
      time: Date.now()
    })
    
    const file = video.file
    const fileSize = video.size
    
    if (!file) {
      console.log(`File object missing for video ${id}`)
      return res.status(500).json({ error: "File object missing" })
    }
    
    // Get range header
    const range = req.headers.range
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range')
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
      return res.status(200).end()
    }
    
    // Set content type based on file extension
    res.setHeader('Content-Type', video.mimeType)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'no-cache')
    
    if (!range) {
      // Full video request
      console.log(`Sending full video (${formatBytes(fileSize)})`)
      res.setHeader('Content-Length', fileSize)
      res.status(200)
      
      const stream = file.download()
      
      stream.on('error', (err) => {
        console.error('Stream error:', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      })
      
      stream.on('end', () => {
        console.log(`Stream ended for ${video.name} (${Date.now() - startTime}ms)`)
      })
      
      stream.pipe(res)
    } else {
      // Partial content request
      const parts = range.replace(/bytes=/, "").split("-")
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = (end - start) + 1
      
      console.log(`Sending partial ${start}-${end}/${fileSize} (${formatBytes(chunkSize)})`)
      
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      res.setHeader('Content-Length', chunkSize)
      res.status(206)
      
      const stream = file.download({ start, end })
      
      stream.on('error', (err) => {
        console.error('Partial stream error:', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      })
      
      stream.on('end', () => {
        console.log(`Partial stream ended (${Date.now() - startTime}ms)`)
      })
      
      stream.pipe(res)
    }
  } catch (err) {
    console.error('Video streaming error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  }
})

// Regenerate thumbnails endpoint (admin only - no auth for simplicity)
app.post("/regenerate-thumbnails", async (req, res) => {
  console.log("🔄 Regenerating all thumbnails...")
  
  // Clear existing thumbnails
  const files = fs.readdirSync(THUMB_DIR)
  files.forEach(file => {
    if (file.endsWith('.jpg')) {
      fs.unlinkSync(path.join(THUMB_DIR, file))
    }
  })
  
  // Generate new thumbnails
  await generateAllThumbnails()
  
  res.json({ message: "Thumbnails regenerated", count: videos.length })
})

// Start server
app.listen(PORT, () => {
  console.log("\n🚀 Server is running!")
  console.log(`📍 Port: ${PORT}`)
  console.log(`📁 Thumbnail directory: ${THUMB_DIR}`)
  console.log("\n📡 Endpoints:")
  console.log(`   • http://localhost:${PORT}/`)
  console.log(`   • http://localhost:${PORT}/list`)
  console.log(`   • http://localhost:${PORT}/thumbnail/0`)
  console.log(`   • http://localhost:${PORT}/video/0`)
  console.log(`   • http://localhost:${PORT}/debug`)
  console.log(`   • http://localhost:${PORT}/stats`)
  console.log("\n⏳ Loading MEGA folder...\n")
})