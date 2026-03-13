const express = require("express")
const Mega = require("megajs")
const cors = require("cors")
const fs = require("fs")
const path = require("path")

const app = express()

app.use(cors())
app.use(express.json({ limit: "10mb" }))

const PORT = process.env.PORT || 3000

const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ"

let videos = []
let ready = false

let views = {}
let progress = {}
let history = []

const thumbDir = path.join(__dirname, "thumbs")

if (!fs.existsSync(thumbDir)) {
  fs.mkdirSync(thumbDir)
}

/* ---------------- MIME TYPE ---------------- */

function getMime(name) {
  const n = name.toLowerCase()

  if (n.endsWith(".mp4")) return "video/mp4"
  if (n.endsWith(".webm")) return "video/webm"
  if (n.endsWith(".mkv")) return "video/x-matroska"
  if (n.endsWith(".mov")) return "video/quicktime"

  return "application/octet-stream"
}

/* ---------------- LOAD MEGA FOLDER ---------------- */

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
        file: f,
        added: Date.now()
      }))

    ready = true

    console.log("Loaded", videos.length, "videos")

  })

}

loadFolder()

setInterval(loadFolder, 60000)

/* ---------------- BASIC ---------------- */

app.get("/", (req, res) => {
  res.send("Mega streaming server running")
})

/* ---------------- LIST ---------------- */

app.get("/list", (req, res) => {

  if (!ready) return res.json([])

  res.json(videos.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size,
    views: views[v.id] || 0
  })))

})

/* ---------------- SEARCH ---------------- */

app.get("/search", (req, res) => {

  const q = (req.query.q || "").toLowerCase()

  const results = videos.filter(v => v.name.toLowerCase().includes(q))

  res.json(results.map(v => ({
    id: v.id,
    name: v.name,
    size: v.size
  })))

})

/* ---------------- RECENT ---------------- */

app.get("/recent", (req, res) => {

  const recent = [...videos].slice(-10).reverse()

  res.json(recent.map(v => ({
    id: v.id,
    name: v.name
  })))

})

/* ---------------- POPULAR ---------------- */

app.get("/popular", (req, res) => {

  const sorted = [...videos].sort((a, b) => (views[b.id] || 0) - (views[a.id] || 0))

  res.json(sorted.slice(0, 10).map(v => ({
    id: v.id,
    name: v.name,
    views: views[v.id] || 0
  })))

})

/* ---------------- HISTORY ---------------- */

app.get("/history", (req, res) => {
  res.json(history.slice(-20).reverse())
})

/* ---------------- PROGRESS ---------------- */

app.post("/progress", (req, res) => {

  const { videoId, time } = req.body

  progress[videoId] = time

  res.json({ status: "saved" })

})

app.get("/progress/:id", (req, res) => {

  const id = req.params.id

  res.json({ time: progress[id] || 0 })

})

/* ---------------- THUMBNAIL ---------------- */

app.post("/thumbnail", (req, res) => {

  const { videoId, image } = req.body

  if (!image) return res.status(400).send("No image")

  const base64 = image.replace(/^data:image\/png;base64,/, "")

  const filePath = path.join(thumbDir, videoId + ".png")

  fs.writeFileSync(filePath, base64, "base64")

  res.json({ status: "saved" })

})

app.get("/thumbnail/:id", (req, res) => {

  const id = req.params.id

  const filePath = path.join(thumbDir, id + ".png")

  if (fs.existsSync(filePath)) {

    res.sendFile(filePath)

  } else {

    const svg = `
<svg width="400" height="225" xmlns="http://www.w3.org/2000/svg">
<rect width="100%" height="100%" fill="#111"/>
<circle cx="200" cy="112" r="35" fill="#2563eb"/>
<polygon points="190,95 190,130 225,112" fill="white"/>
</svg>
`

    res.setHeader("Content-Type", "image/svg+xml")
    res.send(svg)

  }

})

/* ---------------- VIDEO STREAM ---------------- */

app.get("/video/:id", (req, res) => {

  if (!ready) return res.status(503).send("Loading")

  const id = parseInt(req.params.id)

  const video = videos.find(v => v.id === id)

  if (!video) return res.status(404).send("Video not found")

  views[id] = (views[id] || 0) + 1

  history.push({
    id: id,
    name: video.name,
    time: Date.now()
  })

  const file = video.file
  const mime = getMime(video.name)

  const range = req.headers.range

  if (!range) {

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": file.size,
      "Accept-Ranges": "bytes"
    })

    const stream = file.download({ maxConnections: 4 })

    stream.on("error", err => {
      console.log("Stream error:", err)
      res.end()
    })

    stream.pipe(res)

    return
  }

  const parts = range.replace(/bytes=/, "").split("-")

  let start = Number(parts[0])
  let end = parts[1] ? Number(parts[1]) : file.size - 1

  if (isNaN(start)) start = 0
  if (isNaN(end) || end >= file.size) end = file.size - 1

  const chunkSize = (end - start) + 1

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${file.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": mime,
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  })

  const stream = file.download({
    start,
    end,
    maxConnections: 4
  })

  stream.on("error", err => {
    console.log("Stream error:", err)
    res.end()
  })

  stream.pipe(res)

})

/* ---------------- SERVER ---------------- */

app.listen(PORT, () => {
  console.log("Server running on", PORT)
})