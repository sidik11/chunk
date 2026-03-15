const express = require("express")
const cors = require("cors")
const multer = require("multer")

const {
S3Client,
PutObjectCommand,
GetObjectCommand,
DeleteObjectCommand,
CopyObjectCommand,
ListObjectsV2Command,
HeadObjectCommand
} = require("@aws-sdk/client-s3")

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")

const app = express()

app.use(cors({
origin:"*",
methods:["GET","POST","DELETE"],
allowedHeaders:["Content-Type","Range"]
}))

app.use(express.json())

const PORT = process.env.PORT || 3000

// ===== R2 CONFIG =====

const R2 = new S3Client({
region:"auto",
endpoint:process.env.R2_ENDPOINT,
credentials:{
accessKeyId:process.env.R2_ACCESS_KEY,
secretAccessKey:process.env.R2_SECRET_KEY
}
})

const BUCKET = process.env.BUCKET

// ===== FILE UPLOAD HANDLER (OLD METHOD) =====

const storage = multer.memoryStorage()

const upload = multer({
storage,
limits:{
fileSize: 50 * 1024 * 1024 * 1024
}
})

// ===== ROOT =====

app.get("/",(req,res)=>{
res.send("R2 Streaming Server Running")
})


// ===== SIGNED UPLOAD URL (NEW METHOD) =====

app.get("/sign-upload", async (req,res)=>{

try{

const fileName=req.query.name

if(!fileName){
return res.status(400).send("missing filename")
}

const command=new PutObjectCommand({
Bucket:BUCKET,
Key:fileName
})

const url=await getSignedUrl(R2,command,{expiresIn:300})

res.json({
uploadURL:url,
key:fileName
})

}catch(err){

console.error(err)
res.status(500).send("sign error")

}

})


// ===== LIST VIDEOS =====

app.get("/list", async (req,res)=>{

try{

const data = await R2.send(new ListObjectsV2Command({
Bucket:BUCKET
}))

const videos = (data.Contents || []).map((v,i)=>({
id:i,
key:v.Key,
size:v.Size,
lastModified:v.LastModified
}))

res.json(videos)

}catch(err){

console.error(err)
res.status(500).send("list error")

}

})


// ===== SEARCH =====

app.get("/search", async (req,res)=>{

try{

const q = (req.query.q || "").toLowerCase()

const data = await R2.send(new ListObjectsV2Command({
Bucket:BUCKET
}))

const results = (data.Contents || []).filter(v =>
v.Key.toLowerCase().includes(q)
)

res.json(results)

}catch(err){

console.error(err)
res.status(500).send("search error")

}

})


// ===== STORAGE USAGE =====

app.get("/storage", async (req,res)=>{

try{

const data = await R2.send(new ListObjectsV2Command({
Bucket:BUCKET
}))

let total = 0

;(data.Contents || []).forEach(v=>{
total += v.Size
})

res.json({
files:data.KeyCount || 0,
bytes:total
})

}catch(err){

console.error(err)
res.status(500).send("storage error")

}

})


// ===== SMALL FILE UPLOAD (OLD METHOD) =====

app.post("/upload", upload.single("video"), async (req,res)=>{

try{

const file = req.file

if(!file){
return res.status(400).send("No file uploaded")
}

await R2.send(new PutObjectCommand({

Bucket:BUCKET,
Key:file.originalname,
Body:file.buffer,
ContentType:"video/mp4"

}))

res.json({
status:"uploaded",
name:file.originalname
})

}catch(err){

console.error(err)
res.status(500).send("upload error")

}

})


// ===== DELETE VIDEO =====

app.delete("/delete/:key", async (req,res)=>{

try{

const key = decodeURIComponent(req.params.key)

await R2.send(new DeleteObjectCommand({
Bucket:BUCKET,
Key:key
}))

res.json({
status:"deleted",
key:key
})

}catch(err){

console.error(err)
res.status(500).send("delete error")

}

})


// ===== RENAME VIDEO =====

app.post("/rename", async (req,res)=>{

try{

const {oldName,newName} = req.body

if(!oldName || !newName){
return res.status(400).send("missing name")
}

await R2.send(new CopyObjectCommand({

Bucket:BUCKET,
CopySource:`${BUCKET}/${oldName}`,
Key:newName

}))

await R2.send(new DeleteObjectCommand({
Bucket:BUCKET,
Key:oldName
}))

res.json({
status:"renamed",
old:oldName,
new:newName
})

}catch(err){

console.error(err)
res.status(500).send("rename error")

}

})


// ===== VIDEO STREAM =====

app.get("/video/:key", async (req,res)=>{

try{

const key = decodeURIComponent(req.params.key)
const range = req.headers.range

const meta = await R2.send(new HeadObjectCommand({
Bucket:BUCKET,
Key:key
}))

const fileSize = meta.ContentLength

if(!range){

const data = await R2.send(new GetObjectCommand({
Bucket:BUCKET,
Key:key
}))

res.writeHead(200,{
"Content-Type":"video/mp4",
"Content-Length":fileSize,
"Accept-Ranges":"bytes"
})

data.Body.pipe(res)
return
}

const parts = range.replace(/bytes=/,"").split("-")

const start = parseInt(parts[0],10)
const end = parts[1] ? parseInt(parts[1],10) : fileSize - 1

if(start >= fileSize){
res.status(416).send("invalid range")
return
}

const chunkSize = (end - start) + 1

const data = await R2.send(new GetObjectCommand({

Bucket:BUCKET,
Key:key,
Range:`bytes=${start}-${end}`

}))

res.writeHead(206,{
"Content-Range":`bytes ${start}-${end}/${fileSize}`,
"Accept-Ranges":"bytes",
"Content-Length":chunkSize,
"Content-Type":"video/mp4"
})

data.Body.pipe(res)

}catch(err){

console.error(err)
res.status(500).send("stream error")

}

})


// ===== START SERVER =====

app.listen(PORT,()=>{
console.log("Server running on port "+PORT)
})