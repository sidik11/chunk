const express = require("express")
const Mega = require("megajs")
const cors = require("cors")

const app = express()

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000

const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ"

let videos = []
let ready = false
let megaFolder = null

// analytics
let views = {}
let progress = {}
let history = []

// load MEGA folder
function loadFolder() {
  console.log("Loading MEGA folder...")
  
  const folder = Mega.File.fromURL(folderURL)
  
  folder.loadAttributes(err => {
    if (err) {
      console.log("MEGA error:", err)
      return
    }
    
    megaFolder = folder
    const files = folder.children || []
    
    videos = files
      .filter(f => f && f.name && f.size && /\.(mp4|mkv|webm|mov)$/i.test(f.name))
      .map((f, i) => ({
        id: i,
        name: f.name,
        size: f.size,
        file: f,
        mimeType: getMimeType(f.name)
      }))
    
    ready = true
    console.log("Loaded", videos.length, "videos")
    
    // Log first few videos for debugging
    videos.slice(0, 3).forEach(v => {
      console.log(`Video ${v.id}: ${v.name} (${formatBytes(v.size)})`)
    })
  })
}

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  const mimeTypes = {
    'mp4': 'video/mp4',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'mov': 'video/quicktime'
  }
  return mimeTypes[ext] || 'video/mp4'
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const mb = bytes / 1024 / 1024
  return mb.toFixed(2) + ' MB'
}

loadFolder()

// refresh list every 60s
setInterval(loadFolder, 60000)

// server status
app.get("/", (req, res) => {
  res.send(`
    <h1>Mega Streaming Server</h1>
    <p>Status: ${ready ? '✅ Ready' : '⏳ Loading...'}</p>
    <p>Videos loaded: ${videos.length}</p>
    <p>Endpoints:</p>
    <ul>
      <li><a href="/list">/list</a> - List all videos</li>
      <li><a href="/debug">/debug</a> - Debug info</li>
      <li><a href="/video/0">/video/0</a> - Stream video 0</li>
    </ul>
  `)
})

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    ready,
    videoCount: videos.length,
    videos: videos.map(v => ({
      id: v.id,
      name: v.name,
      size: formatBytes(v.size),
      mimeType: v.mimeType
    })),
    views,
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
    views: views[v.id] || 0
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
    mimeType: v.mimeType
  })))
})

// recent videos
app.get("/recent", (req, res) => {
  const recent = [...videos].slice(-10).reverse()
  
  res.json(recent.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    mimeType: v.mimeType
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
    views: views[v.id] || 0
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

// Test endpoint
app.get("/test/:id", async (req, res) => {
  const id = parseInt(req.params.id)
  const video = videos.find(v => v.id === id)
  
  if (!video) {
    return res.status(404).json({ error: "Video not found" })
  }
  
  try {
    // Try to get file info
    const file = video.file
    res.json({
      id: video.id,
      name: video.name,
      size: video.size,
      sizeFormatted: formatBytes(video.size),
      mimeType: video.mimeType,
      ready: ready,
      hasFile: !!file,
      fileAttributes: file ? Object.keys(file) : []
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// FIXED: Video streaming with better error handling
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
    
    console.log(`Streaming request for: ${video.name} (ID: ${id})`)
    
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
    console.log(`Range header: ${range || 'none'}`)
    
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
      
      // Create download stream with error handling
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
      
      // Create partial download stream
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

// Start server
app.listen(PORT, () => {
  console.log("Server running on port", PORT)
  console.log(`Test URLs:
  - http://localhost:${PORT}/debug
  - http://localhost:${PORT}/list
  - http://localhost:${PORT}/video/0
  `)
})