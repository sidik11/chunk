const express = require("express")
const Mega = require("megajs")
const cors = require("cors")

const app = express()
app.use(cors())

const PORT = process.env.PORT || 3000

const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ"

const folder = Mega.File.fromURL(folderURL)

let files = []
let videos = []
let ready = false


function loadFolder(){

folder.loadAttributes(err=>{

if(err){
console.log("MEGA error:",err)
return
}

files = folder.children || []

// keep only real video files
videos = files.filter(f =>
f &&
f.name &&
f.size &&
/\.(mp4|mkv|webm|mov)$/i.test(f.name)
)

ready = true

console.log("Loaded",videos.length,"videos")

})

}

loadFolder()

// refresh folder every minute
setInterval(loadFolder,60000)



app.get("/list",(req,res)=>{

if(!ready) return res.json([])

const list = videos.map((f,i)=>({
id:i,
name:f.name,
size:f.size
}))

res.json(list)

})



app.get("/video/:id",(req,res)=>{

if(!ready) return res.status(503).send("Loading")

const id = parseInt(req.params.id)

const file = videos[id]

if(!file) return res.status(404).send("Video not found")

const range = req.headers.range

if(!range){

res.setHeader("Content-Type","video/mp4")

file.download().pipe(res)

return

}

const parts = range.replace(/bytes=/,"").split("-")

const start = parseInt(parts[0],10)

const end = parts[1] ? parseInt(parts[1],10) : file.size-1

const chunkSize = (end-start)+1

res.writeHead(206,{
"Content-Range":`bytes ${start}-${end}/${file.size}`,
"Accept-Ranges":"bytes",
"Content-Length":chunkSize,
"Content-Type":"video/mp4"
})

const stream = file.download({start,end})

stream.pipe(res)

})



app.get("/",(req,res)=>{
res.send("Mega streaming server running")
})



app.listen(PORT,()=>{
console.log("Server running on",PORT)
})