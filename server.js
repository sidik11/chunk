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

let views = {}
let progress = {}
let history = []

function loadFolder(){

const folder = Mega.File.fromURL(folderURL)

folder.loadAttributes(err => {

if(err){
console.log("MEGA error:",err)
return
}

const files = folder.children || []

videos = files
.filter(f => f && f.name && f.size && /\.(mp4|mkv|webm|mov)$/i.test(f.name))
.map((f,i)=>({
id:i,
name:f.name,
size:f.size,
file:f,
added:Date.now()
}))

ready = true

console.log("Loaded",videos.length,"videos")

})

}

loadFolder()

setInterval(loadFolder,60000)



app.get("/",(req,res)=>{
res.send("Mega streaming server running")
})



app.get("/list",(req,res)=>{

if(!ready) return res.json([])

res.json(videos.map(v=>({
id:v.id,
name:v.name,
size:v.size,
views:views[v.id] || 0
})))

})



app.get("/search",(req,res)=>{

const q=(req.query.q || "").toLowerCase()

const results=videos.filter(v=>v.name.toLowerCase().includes(q))

res.json(results.map(v=>({
id:v.id,
name:v.name,
size:v.size
})))

})



app.get("/recent",(req,res)=>{

const recent=[...videos].slice(-10).reverse()

res.json(recent.map(v=>({
id:v.id,
name:v.name
})))

})



app.get("/popular",(req,res)=>{

const sorted=[...videos].sort((a,b)=>(views[b.id]||0)-(views[a.id]||0))

res.json(sorted.slice(0,10).map(v=>({
id:v.id,
name:v.name,
views:views[v.id] || 0
})))

})



app.get("/history",(req,res)=>{
res.json(history.slice(-20).reverse())
})



app.post("/progress",(req,res)=>{

const {videoId,time}=req.body

progress[videoId]=time

res.json({status:"saved"})

})



app.get("/progress/:id",(req,res)=>{

const id=req.params.id

res.json({time:progress[id] || 0})

})



app.get("/video/:id",(req,res)=>{

if(!ready) return res.status(503).send("Loading")

const id=parseInt(req.params.id)

const video=videos.find(v=>v.id===id)

if(!video) return res.status(404).send("Video not found")

views[id]=(views[id] || 0) + 1

history.push({
id:id,
name:video.name,
time:Date.now()
})

const file=video.file

const range=req.headers.range

if(!range){

res.setHeader("Content-Type","video/mp4")

file.download().pipe(res)

return

}

const parts=range.replace(/bytes=/,"").split("-")

const start=parseInt(parts[0],10)

const end=parts[1] ? parseInt(parts[1],10) : file.size-1

const chunkSize=(end-start)+1

res.writeHead(206,{
"Content-Range":`bytes ${start}-${end}/${file.size}`,
"Accept-Ranges":"bytes",
"Content-Length":chunkSize,
"Content-Type":"video/mp4"
})

const stream=file.download({start,end})

stream.pipe(res)

})



app.listen(PORT,()=>{
console.log("Server running on",PORT)
})