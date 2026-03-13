const express = require("express")
const Mega = require("megajs")

const app = express()

const PORT = process.env.PORT || 3000

const folderURL = "https://mega.nz/folder/o7ZHQBQT#VezNIK2oyYEW3LxRAjcPfQ"

const folder = Mega.File.fromURL(folderURL)

let files = []
let ready = false

function loadFolder(){

folder.loadAttributes(err=>{

if(err){
console.log("MEGA error:",err)
return
}

files = folder.children

ready = true

console.log("Loaded",files.length,"files")

})

}

loadFolder()

setInterval(loadFolder,60000)

app.get("/list",(req,res)=>{

if(!ready) return res.json([])

res.json(files.map((f,i)=>({
id:i,
name:f.name,
size:f.size
})))

})

app.get("/video/:id",(req,res)=>{

if(!ready) return res.status(503).send("Loading")

const id = parseInt(req.params.id)

if(!files[id]) return res.status(404).send("Video not found")

const file = files[id]

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

app.listen(PORT,()=>{
console.log("Server running on",PORT)
})