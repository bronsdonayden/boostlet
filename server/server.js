// boostlet sync server
// handles pusher channel auth (required for presence channels)
// and scene snapshot storage so late joiners can load the scene
// signaling (offer/answer/ice) goes peer to peer via pusher client events
// no websocket server needed

const express = require('express')
const cors = require('cors')
const Pusher = require('pusher')

const app = express()
app.use(cors())
app.use(express.json())

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
})

// in memory scene store keyed by room code
// scenes expire after 2 hours to avoid unbounded growth
const scenes = new Map()
const SCENE_TTL = 2 * 60 * 60 * 1000

function pruneScenes() {
  const now = Date.now()
  for (const [code, entry] of scenes) {
    if (now - entry.ts > SCENE_TTL) scenes.delete(code)
  }
}
setInterval(pruneScenes, 10 * 60 * 1000)

function makeCode() {
  // 5 character alphanumeric room code
  return Math.random().toString(36).slice(2, 7)
}

// pusher requires server side auth for presence and private channels
// the client sends its socket id and the channel name
// we sign it and send back the auth token
app.post('/pusher/auth', (req, res) => {
  const { socket_id, channel_name } = req.body
  if (!socket_id || !channel_name) return res.status(400).json({ error: 'missing fields' })

  // presence channels carry member data — use user_id from request body
  const presenceData = channel_name.startsWith('presence-') ? {
    user_id: req.body.user_id || socket_id,
    user_info: {}
  } : null

  try {
    const auth = presenceData
      ? pusher.authorizeChannel(socket_id, channel_name, presenceData)
      : pusher.authorizeChannel(socket_id, channel_name)
    res.json(auth)
  } catch (e) {
    res.status(500).json({ error: 'auth failed' })
  }
})

// create a new scene and return its room code
app.post('/scene', (req, res) => {
  pruneScenes()
  let code = makeCode()
  while (scenes.has(code)) code = makeCode()
  scenes.set(code, { scene: req.body, ts: Date.now() })
  res.json({ code })
})

// fetch scene for a room code
app.get('/scene/:code', (req, res) => {
  const entry = scenes.get(req.params.code)
  if (!entry) return res.status(404).json({ error: 'not found' })
  res.json(entry.scene)
})

// patch scene with updated display state (host polls this every 3s)
app.patch('/scene/:code', (req, res) => {
  const entry = scenes.get(req.params.code)
  if (!entry) return res.status(404).json({ error: 'not found' })
  Object.assign(entry.scene, req.body)
  entry.ts = Date.now()
  res.json({ ok: true })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`boostlet server running on ${PORT}`))
