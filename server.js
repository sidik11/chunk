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

// analytics
let views = {}
let progress = {}
let history = []

// load MEGA folder
function loadFolder() {
  const folder = Mega.File.fromURL(folderURL)
  
  folder.loadAttributes(err => {
    if (err) {
      console.log("MEGA error:", err)
      return
    }
    
    const files = folder.children || []
    
    videos = files
      .filter(f => f && f.name && f.size && /\.(mp4|mkv|webm|mov)$/i.test(f.name))
      .map((f, i) => ({
        id: i,
        name: f.name,
        size: f.size,
        file: f
      }))
    
    ready = true
    console.log("Loaded", videos.length, "videos")
  })
}

loadFolder()

// refresh list every 60s
setInterval(loadFolder, 60000)

// server status
app.get("/", (req, res) => {
  res.send("Mega streaming server running")
})

// video list
app.get("/list", (req, res) => {
  if (!ready) return res.json([])
  
  res.json(videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
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
    size: v.size
  })))
})

// recent videos
app.get("/recent", (req, res) => {
  const recent = [...videos].slice(-10).reverse()
  
  res.json(recent.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size
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
  progress[videoId] = time
  res.json({ status: "saved" })
})

// get playback progress
app.get("/progress/:id", (req, res) => {
  const id = req.params.id
  res.json({ time: progress[id] || 0 })
})

// FIXED: Video streaming with proper headers and error handling
app.get("/video/:id", (req, res) => {
  if (!ready) {
    return res.status(503).json({ error: "Server loading" })
  }
  
  const id = parseInt(req.params.id)
  const video = videos.find(v => v.id === id)
  
  if (!video) {
    return res.status(404).json({ error: "Video not found" })
  }
  
  // Update analytics
  views[id] = (views[id] || 0) + 1
  history.push({
    id: id,
    name: video.name,
    time: Date.now()
  })
  
  const file = video.file
  const fileSize = video.size
  
  // Get range header
  const range = req.headers.range
  
  try {
    // Set proper headers for video streaming
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'video/mp4')
    
    if (!range) {
      // Full video request
      res.setHeader('Content-Length', fileSize)
      res.status(200)
      
      const stream = file.download()
      
      stream.on('error', (err) => {
        console.error('Stream error:', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      })
      
      stream.pipe(res)
    } else {
      // Partial content request
      const parts = range.replace(/bytes=/, "").split("-")
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = (end - start) + 1
      
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      res.setHeader('Content-Length', chunkSize)
      res.status(206)
      
      const stream = file.download({ start, end })
      
      stream.on('error', (err) => {
        console.error('Stream error:', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      })
      
      stream.pipe(res)
    }
  } catch (err) {
    console.error('Video streaming error:', err)
    res.status(500).json({ error: 'Streaming failed' })
  }
})

// Add a test endpoint to verify video streaming
app.get("/test/:id", async (req, res) => {
  const id = parseInt(req.params.id)
  const video = videos.find(v => v.id === id)
  
  if (!video) {
    return res.status(404).json({ error: "Video not found" })
  }
  
  res.json({
    id: video.id,
    name: video.name,
    size: video.size,
    ready: ready
  })
})

// Start server
app.listen(PORT, () => {
  console.log("Server running on port", PORT)
})