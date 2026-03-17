const express = require("express")
const cors = require("cors")
const multer = require("multer")
const fs = require("fs-extra")
const path = require("path")
const crypto = require("crypto")
const mime = require("mime-types")

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
  origin: "*",
  methods: ["GET","POST","DELETE"],
  allowedHeaders: ["Content-Type","Range","uploadid","chunkindex"]
}))

app.use(express.json())

const PORT = process.env.PORT || 3000

// ===== R2 CONFIG =====

const R2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY
  }
})

const BUCKET = process.env.BUCKET

// ===== TEMP STORAGE =====
const TEMP_DIR = path.join(__dirname, "temp")
fs.ensureDirSync(TEMP_DIR)

// ===== HASH DB =====
const HASH_FILE = path.join(__dirname, "hashes.json")
let hashDB = fs.existsSync(HASH_FILE)
  ? JSON.parse(fs.readFileSync(HASH_FILE))
  : {}

function saveHashDB(){
  fs.writeFileSync(HASH_FILE, JSON.stringify(hashDB))
}

// ===== MULTER (SMALL FILE FALLBACK) =====
const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits:{ fileSize: 50 * 1024 * 1024 * 1024 }
})

// ===== ROOT =====
app.get("/", (req,res)=>{
  res.send("Advanced R2 Streaming Server Running 🚀")
})


// =====================================================
// 🔐 DUPLICATE CHECK
// =====================================================
app.post("/check-file",(req,res)=>{
  const { hash } = req.body
  if(hashDB[hash]){
    return res.json({ exists:true, file:hashDB[hash] })
  }
  res.json({ exists:false })
})


// =====================================================
// 🔗 SIGNED UPLOAD (KEEP YOUR OLD SYSTEM WORKING)
// =====================================================
app.get("/sign-upload", async (req,res)=>{
  try{
    const fileName=req.query.name
    if(!fileName) return res.status(400).send("missing filename")

    const command=new PutObjectCommand({
      Bucket:BUCKET,
      Key:fileName
    })

    const url=await getSignedUrl(R2,command,{expiresIn:300})

    res.json({ uploadURL:url, key:fileName })

  }catch(err){
    console.error(err)
    res.status(500).send("sign error")
  }
})


// =====================================================
// 📦 CHUNK UPLOAD
// =====================================================
app.post("/upload-chunk", async (req,res)=>{

  const uploadId = req.headers.uploadid
  const chunkIndex = req.headers.chunkindex

  if(!uploadId) return res.status(400).send("missing uploadId")

  const dir = path.join(TEMP_DIR, uploadId)
  await fs.ensureDir(dir)

  const chunkPath = path.join(dir, "chunk_"+chunkIndex)

  const writeStream = fs.createWriteStream(chunkPath)
  req.pipe(writeStream)

  req.on("end", ()=>{
    res.json({ ok:true })
  })
})


// =====================================================
// 🔄 RESUME CHECK
// =====================================================
app.get("/upload-status",(req,res)=>{
  const uploadId = req.query.uploadId
  const dir = path.join(TEMP_DIR, uploadId)

  if(!fs.existsSync(dir)){
    return res.json({ uploaded:[] })
  }

  const files = fs.readdirSync(dir)
  const uploaded = files.map(f => parseInt(f.split("_")[1]))

  res.json({ uploaded })
})


// =====================================================
// 🧩 MERGE + UPLOAD TO R2
// =====================================================
app.post("/merge", async (req,res)=>{
  try{
    const { uploadId, fileName, totalChunks, hash } = req.body

    const dir = path.join(TEMP_DIR, uploadId)
    const finalPath = path.join(TEMP_DIR, fileName)

    const writeStream = fs.createWriteStream(finalPath)

    for(let i=0;i<totalChunks;i++){
      const chunkPath = path.join(dir,"chunk_"+i)
      const data = fs.readFileSync(chunkPath)
      writeStream.write(data)
    }

    writeStream.end()

    writeStream.on("finish", async ()=>{

      const fileBuffer = fs.readFileSync(finalPath)

      await R2.send(new PutObjectCommand({
        Bucket:BUCKET,
        Key:fileName,
        Body:fileBuffer,
        ContentType: mime.lookup(fileName) || "application/octet-stream"
      }))

      // save hash
      if(hash){
        hashDB[hash] = fileName
        saveHashDB()
      }

      // cleanup
      fs.removeSync(dir)
      fs.removeSync(finalPath)

      res.json({ success:true })
    })

  }catch(err){
    console.error(err)
    res.status(500).send("merge error")
  }
})


// =====================================================
// 📤 SMALL FILE UPLOAD (KEEP BACKWARD COMPATIBILITY)
// =====================================================
app.post("/upload", upload.single("video"), async (req,res)=>{
  try{
    const file = req.file
    if(!file) return res.status(400).send("No file")

    await R2.send(new PutObjectCommand({
      Bucket:BUCKET,
      Key:file.originalname,
      Body:file.buffer,
      ContentType: mime.lookup(file.originalname) || "application/octet-stream"
    }))

    res.json({ status:"uploaded", name:file.originalname })

  }catch(err){
    console.error(err)
    res.status(500).send("upload error")
  }
})


// =====================================================
// 📃 LIST
// =====================================================
app.get("/list", async (req,res)=>{
  try{
    const data = await R2.send(new ListObjectsV2Command({ Bucket:BUCKET }))

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


// =====================================================
// 💾 STORAGE
// =====================================================
app.get("/storage", async (req,res)=>{
  try{
    const data = await R2.send(new ListObjectsV2Command({ Bucket:BUCKET }))

    let total = 0
    ;(data.Contents || []).forEach(v=> total += v.Size)

    res.json({
      files:data.KeyCount || 0,
      bytes:total
    })

  }catch(err){
    console.error(err)
    res.status(500).send("storage error")
  }
})


// =====================================================
// ❌ DELETE
// =====================================================
app.delete("/delete/:key", async (req,res)=>{
  try{
    const key = decodeURIComponent(req.params.key)

    await R2.send(new DeleteObjectCommand({
      Bucket:BUCKET,
      Key:key
    }))

    res.json({ status:"deleted" })

  }catch(err){
    console.error(err)
    res.status(500).send("delete error")
  }
})


// =====================================================
// ✏️ RENAME
// =====================================================
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

    res.json({ status:"renamed" })

  }catch(err){
    console.error(err)
    res.status(500).send("rename error")
  }
})


// =====================================================
// 🎬 STREAM (FIXED FOR ALL VIDEO TYPES)
// =====================================================
app.get("/video/:key", async (req,res)=>{

  try{

    const key = decodeURIComponent(req.params.key)
    const range = req.headers.range

    const meta = await R2.send(new HeadObjectCommand({
      Bucket:BUCKET,
      Key:key
    }))

    const fileSize = meta.ContentLength
    const contentType = mime.lookup(key) || "application/octet-stream"

    if(!range){
      const data = await R2.send(new GetObjectCommand({
        Bucket:BUCKET,
        Key:key
      }))

      res.writeHead(200,{
        "Content-Type":contentType,
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
      return res.status(416).send("invalid range")
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
      "Content-Type":contentType
    })

    data.Body.pipe(res)

  }catch(err){
    console.error(err)
    res.status(500).send("stream error")
  }
})


// ===== START =====
app.listen(PORT,()=>{
  console.log("Server running on port "+PORT)
})