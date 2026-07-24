;(function () {
  // guard against double injection
  if (window.__boostlet_collab_injected) return
  window.__boostlet_collab_injected = true

  const BOOSTLET_URL = 'https://boostlet.org/dist/boostlet.min.js'
  const SIGNAL_URL = 'wss://aydenbronsdon.com/signal'

  // load boostlet if not already present then wait for nv
  if (window.Boostlet) {
    waitForNv()
  } else {
    const boostletScript = document.createElement('script')
    boostletScript.src = BOOSTLET_URL
    boostletScript.onload = waitForNv
    document.head.appendChild(boostletScript)
  }

  function waitForNv() {
    // poll until niivue is ready and at least one volume slot exists
    const poll = setInterval(() => {
      try {
        Boostlet.init()
        if (Boostlet.framework.name !== 'niivue') return
        const nv = Boostlet.framework.instance
        if (!nv || nv.volumes === undefined) return
        clearInterval(poll)
        run(nv)
      } catch(e) {}
    }, 300)
  }

  function run(nv) {
    // the peer who creates the room (no room param in url) is the canonical peer
    const params = new URLSearchParams(location.search)
    const startsRoom = !params.get('room')
    const roomId = params.get('room') || generateRoomId()
    const sharedVolumeUrl = params.get('volume')
    const peers = new Map()

    let selfId = null
    let roomPeers = []
    let canonicalPeerId = null
    let isCanonicalPeer = startsRoom
    let myVolumeHash = null
    let canonicalHash = null
    // flag set while applying a remote update so we do not echo it back
    let applyingRemote = false
    let triedSharedVolume = false
    let lastUploadPromptAt = 0

    let drawMode = null
    let brushSize = 3
    let label = 1
    // tracks last known crosshair position to diff against in syncLoop
    let lastPos = Array.from((nv.scene && nv.scene.crosshairPos) || [0, 0, 0])

    if (startsRoom) {
      const shareParams = new URLSearchParams(location.search)
      const base = nv.volumes && nv.volumes[0]
      shareParams.set('room', roomId)
      if (base && base.url && !base.url.startsWith('blob:')) {
        shareParams.set('volume', base.url)
      }
      history.replaceState(null, '', `${location.pathname}?${shareParams.toString()}${location.hash}`)
      Boostlet.hint('session started share this url with your peers', 4000)
    }

    // open websocket to signaling server for offer/answer/ice exchange
    const signal = new WebSocket(`${SIGNAL_URL}?room=${encodeURIComponent(roomId)}`)

    setupDrawing()
    setupSliceSync()
    setupLocationSync()
    setupKeyHandlers()

    onBaseVolumeChanged(nv, async (baseVolume) => {
      if (!baseVolume || !baseVolume.img) return
      myVolumeHash = await hashVolume(baseVolume)
      if (isCanonicalPeer) {
        canonicalHash = myVolumeHash
        Boostlet.hint('volume ready', 2000)
      }
      ensureDrawBitmap()
      evaluateAllPeers()
      sendHashCheckToAll()
    })

    signal.onerror = () => {
      Boostlet.hint('could not reach signaling server', 4000)
    }

    signal.onmessage = async (raw) => {
      let msg
      try { msg = JSON.parse(raw.data) } catch { return }
      try {
        if (msg.type === 'room-state') { handleRoomState(msg); return }
        if (msg.type === 'peer-joined') { await handlePeerJoined(msg.peerId); return }
        if (msg.type === 'peer-disconnected') { removePeer(msg.peerId); return }
        if (!msg.from) return
        if (msg.type === 'offer') await handleOffer(msg.from, msg.payload)
        if (msg.type === 'answer') await handleAnswer(msg.from, msg.payload)
        if (msg.type === 'ice') await handleIce(msg.from, msg.payload)
      } catch (err) { console.error(err) }
    }

    requestAnimationFrame(syncLoop)

    // server sends room state on join so we know our own id and existing peers
    function handleRoomState(msg) {
      selfId = msg.peerId
      roomPeers = msg.peers.concat(selfId)
      updateCanonicalPeer()
    }

    async function handlePeerJoined(peerId) {
      if (!roomPeers.includes(peerId)) roomPeers.push(peerId)
      updateCanonicalPeer()
      await makeOffer(peerId)
    }

    // the earliest peer in the list is canonical and owns the reference volume hash
    function updateCanonicalPeer() {
      canonicalPeerId = roomPeers[0] || selfId
      isCanonicalPeer = canonicalPeerId === selfId
      if (isCanonicalPeer && myVolumeHash) {
        canonicalHash = myVolumeHash
        sendHashCheckToAll()
      }
      evaluateAllPeers()
    }

    async function makeOffer(peerId) {
      if (!peerId || peerId === selfId) return
      const peer = getPeer(peerId, true, true)
      if (peer.conn.signalingState !== 'stable') return
      const offer = await peer.conn.createOffer()
      await peer.conn.setLocalDescription(offer)
      sendSignal('offer', peerId, offer)
    }

    async function handleOffer(peerId, offer) {
      const peer = getPeer(peerId, false, false)
      await peer.conn.setRemoteDescription(offer)
      peer.remoteDescSet = true
      // flush any candidates that arrived before the remote description was set
      await flushCandidates(peer)
      const answer = await peer.conn.createAnswer()
      await peer.conn.setLocalDescription(answer)
      sendSignal('answer', peerId, answer)
    }

    async function handleAnswer(peerId, answer) {
      const peer = peers.get(peerId)
      if (!peer) return
      await peer.conn.setRemoteDescription(answer)
      peer.remoteDescSet = true
      await flushCandidates(peer)
    }

    // buffer candidates until remote description is ready
    async function handleIce(peerId, candidate) {
      if (!candidate || !peers.has(peerId)) return
      const peer = peers.get(peerId)
      if (peer.remoteDescSet) {
        await peer.conn.addIceCandidate(candidate)
      } else {
        peer.pendingCandidates.push(candidate)
      }
    }

    async function flushCandidates(peer) {
      for (const candidate of peer.pendingCandidates) {
        await peer.conn.addIceCandidate(candidate)
      }
      peer.pendingCandidates = []
    }

    function getPeer(peerId, createChannel, shouldSendSnapshot) {
      if (peers.has(peerId)) {
        const peer = peers.get(peerId)
        if (shouldSendSnapshot) peer.shouldSendSnapshot = true
        if (createChannel) createDataChannel(peerId, peer)
        return peer
      }
      const conn = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      const peer = {
        conn, channel: null, pendingCandidates: [],
        remoteDescSet: false, verified: false, hash: null,
        shouldSendSnapshot: Boolean(shouldSendSnapshot)
      }
      peers.set(peerId, peer)
      conn.onicecandidate = (e) => { if (e.candidate) sendSignal('ice', peerId, e.candidate) }
      conn.ondatachannel = (e) => { wireDataChannel(peerId, e.channel) }
      conn.onconnectionstatechange = () => {
        if (conn.connectionState === 'failed' || conn.connectionState === 'closed') removePeer(peerId)
      }
      if (createChannel) createDataChannel(peerId, peer)
      return peer
    }

    function createDataChannel(peerId, peer) {
      if (peer.channel && peer.channel.readyState !== 'closed') return
      const channel = peer.conn.createDataChannel('boostlet-collab')
      wireDataChannel(peerId, channel)
    }

    function wireDataChannel(peerId, channel) {
      const peer = peers.get(peerId)
      if (!peer) { channel.close(); return }
      peer.channel = channel
      channel.binaryType = 'arraybuffer'

      channel.onopen = async () => {
        // joiner tries to auto load the shared volume url from the room link
        if (!isCanonicalPeer && sharedVolumeUrl && !triedSharedVolume && !(nv.volumes && nv.volumes[0])) {
          triedSharedVolume = true
          const ok = await tryLoadSharedVolume(sharedVolumeUrl)
          if (!ok) promptManualUpload()
        }
        if (myVolumeHash) {
          sendHashCheck(peerId)
        } else {
          Boostlet.hint('connected load a volume to begin verification', 3000)
        }
      }

      channel.onmessage = (e) => handleDataMessage(peerId, e)
      channel.onclose = () => {
        const current = peers.get(peerId)
        if (!current || current.channel !== channel) return
        current.channel = null
        current.verified = false
      }
    }

    function handleDataMessage(peerId, e) {
      const peer = peers.get(peerId)
      if (!peer) return
      if (typeof e.data !== 'string') {
        if (peer.verified) handleDrawSnapshotBinary(e.data)
        return
      }
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'hash-check') { handleHashCheck(peerId, msg.hash); return }
      if (!peer.verified) return
      if (msg.type === 'crosshair') handleCrosshairUpdate(msg)
      if (msg.type === 'sliceType') handleSliceTypeUpdate(msg)
      if (msg.type === 'draw') handleDrawUpdate(msg)
      if (msg.type === 'draw-commit') handleDrawCommit()
    }

    // peers exchange sha256 hashes to confirm they have the same volume before syncing
    function handleHashCheck(peerId, hash) {
      const peer = peers.get(peerId)
      if (!peer || !hash) return
      peer.hash = hash
      if (!canonicalHash && (!canonicalPeerId || peerId === canonicalPeerId)) canonicalHash = hash
      if (canonicalHash && !myVolumeHash) {
        Boostlet.hint('please load a volume to join the session', 4000)
        promptManualUpload()
      }
      if (canonicalHash && myVolumeHash && myVolumeHash !== canonicalHash) {
        Boostlet.hint('volume mismatch please upload the same file', 5000)
        promptManualUpload()
      }
      evaluateAllPeers()
    }

    function evaluateAllPeers() {
      peers.forEach((peer, peerId) => {
        const wasVerified = peer.verified
        peer.verified = Boolean(
          myVolumeHash && canonicalHash &&
          myVolumeHash === canonicalHash &&
          peer.hash === canonicalHash
        )
        if (peer.verified && !wasVerified) {
          Boostlet.hint(`${verifiedCount()} peer${verifiedCount() === 1 ? '' : 's'} verified sync active`, 2000)
          if (isCanonicalPeer && peer.shouldSendSnapshot) {
            sendInitialSync(peerId)
            peer.shouldSendSnapshot = false
          }
        }
        if (!peer.verified && wasVerified) Boostlet.hint('peer volume mismatch sync paused', 3000)
      })
    }

    function verifiedCount() {
      let count = 0
      peers.forEach((peer) => { if (peer.verified) count++ })
      return count
    }

    function hasVerifiedPeer() {
      for (const peer of peers.values()) {
        if (peer.verified) return true
      }
      return false
    }

    function sendInitialSync(peerId) {
      ensureDrawBitmap()
      sendToPeer(peerId, { type: 'sliceType', sliceType: nv.opts.sliceType })
      sendToPeer(peerId, { type: 'crosshair', crosshairPos: Array.from(nv.scene.crosshairPos) })
      sendDrawSnapshot(peerId)
    }

    function sendHashCheckToAll() {
      peers.forEach((_, peerId) => sendHashCheck(peerId))
    }

    function sendHashCheck(peerId) {
      if (!myVolumeHash) return
      sendToPeer(peerId, { type: 'hash-check', hash: myVolumeHash }, false)
    }

    function sendSignal(type, to, payload) {
      if (signal.readyState !== WebSocket.OPEN) return
      signal.send(JSON.stringify({ type, to, payload }))
    }

    function sendToPeer(peerId, msg, requireVerified = true) {
      const peer = peers.get(peerId)
      if (!peer || !peer.channel || peer.channel.readyState !== 'open') return
      if (requireVerified && !peer.verified) return
      try { peer.channel.send(JSON.stringify(msg)) } catch (err) { console.error(err) }
    }

    function broadcast(msg) {
      const str = JSON.stringify(msg)
      peers.forEach((peer) => {
        if (!peer.verified || !peer.channel || peer.channel.readyState !== 'open') return
        try { peer.channel.send(str) } catch (err) { console.error(err) }
      })
    }

    function sendDrawSnapshot(peerId) {
      const buffer = makeDrawSnapshotBuffer()
      if (!buffer) return
      const peer = peers.get(peerId)
      if (!peer || !peer.channel || peer.channel.readyState !== 'open' || !peer.verified) return
      try { peer.channel.send(buffer) } catch (err) { console.error(err) }
    }

    function broadcastDrawSnapshot() {
      const buffer = makeDrawSnapshotBuffer()
      if (!buffer) return
      peers.forEach((peer) => {
        if (!peer.verified || !peer.channel || peer.channel.readyState !== 'open') return
        try { peer.channel.send(buffer) } catch (err) { console.error(err) }
      })
    }

    function makeDrawSnapshotBuffer() {
      ensureDrawBitmap()
      if (!nv.drawBitmap || !hasDrawBitmapPaint()) return null
      const view = nv.drawBitmap
      return (view.buffer && view.byteLength !== undefined)
        ? view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
        : Uint8Array.from(view).buffer
    }

    function hasDrawBitmapPaint() {
      if (!nv.drawBitmap) return false
      for (let i = 0; i < nv.drawBitmap.length; i++) {
        if (nv.drawBitmap[i] !== 0) return true
      }
      return false
    }

    async function tryLoadSharedVolume(url) {
      try {
        const res = await fetch(url, { method: 'HEAD', mode: 'cors' })
        if (!res.ok) throw new Error('not reachable')
        await nv.loadVolumes([{ url }])
        return true
      } catch { return false }
    }

    function promptManualUpload() {
      const now = Date.now()
      if (now - lastUploadPromptAt < 5000) return
      lastUploadPromptAt = now
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.nii,.nii.gz'
      input.onchange = async (e) => {
        const file = e.target.files[0]
        if (!file) return
        await nv.loadVolumes([{ url: URL.createObjectURL(file), name: file.name }])
      }
      input.click()
    }

    function setupDrawing() {
      nv.drawOpacity = 1.0
      ensureDrawBitmap()
    }

    function ensureDrawBitmap() {
      if (nv.drawBitmap || !nv.back) return
      nv.setDrawingEnabled(true)
      nv.setDrawingEnabled(false)
    }

    function setupSliceSync() {
      let lastSliceType = nv.opts.sliceType
      // intercept slice type changes via property descriptor if the property is configurable
      const sliceDescriptor = Object.getOwnPropertyDescriptor(nv.opts, 'sliceType')
      if (!sliceDescriptor || sliceDescriptor.configurable !== false) {
        Object.defineProperty(nv.opts, 'sliceType', {
          get() { return lastSliceType },
          set(val) {
            lastSliceType = val
            if (applyingRemote || !hasVerifiedPeer()) return
            broadcast({ type: 'sliceType', sliceType: val })
          },
          configurable: true,
          enumerable: sliceDescriptor ? sliceDescriptor.enumerable : true
        })
      } else {
        // fall back to wrapping the callback if the descriptor is not configurable
        const prevSliceHandler = typeof nv.onSliceTypeChange === 'function' ? nv.onSliceTypeChange : null
        nv.onSliceTypeChange = function (sliceType) {
          if (prevSliceHandler) prevSliceHandler.call(this, sliceType)
          if (applyingRemote || !hasVerifiedPeer()) return
          broadcast({ type: 'sliceType', sliceType })
        }
      }
    }

    function setupLocationSync() {
      // chain onto existing handler so other boostlets keep working
      const prevHandler = nv.onLocationChange
      nv.onLocationChange = function (loc) {
        if (prevHandler) prevHandler.call(this, loc)
        const drawPosition = loc && loc.vox
        ensureDrawBitmap()
        // paint and broadcast if the user is actively drawing
        if (drawMode && drawPosition && !applyingRemote) {
          const vox = Array.from(drawPosition)
          paintAt(vox, drawMode, brushSize, label)
          broadcast({ type: 'draw', vox, brushSize, label, mode: drawMode })
        }
      }
    }

    function setupKeyHandlers() {
  window.addEventListener('keydown', (e) => {
    if (e.key === '1') { drawMode = 'paint'; if (nv.canvas) nv.canvas.style.cursor = 'crosshair'; e.preventDefault(); return }
    if (e.key === '2') { drawMode = 'erase'; if (nv.canvas) nv.canvas.style.cursor = 'crosshair'; e.preventDefault(); return }
    if (e.key === '[') { brushSize = Math.max(1, brushSize - 1); e.preventDefault(); return }
    if (e.key === ']') { brushSize = Math.min(25, brushSize + 1); e.preventDefault(); return }

    if (e.code === 'KeyZ' && !e.repeat) {
      ensureDrawBitmap()
      if (nv.drawBitmap && typeof nv.drawUndo === 'function') {
        nv.drawUndo()
        if (typeof nv.refreshDrawing === 'function') nv.refreshDrawing(true)
        if (nv.drawBitmap) {
          const view = nv.drawBitmap
          const buffer = (view.buffer && view.byteLength !== undefined)
            ? view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
            : Uint8Array.from(view).buffer
          peers.forEach((peer) => {
            if (!peer.verified || !peer.channel || peer.channel.readyState !== 'open') return
            try { peer.channel.send(buffer) } catch (err) { console.error(err) }
          })
        }
      }
      e.preventDefault()
    }
  })

  window.addEventListener('keyup', (e) => {
    if (e.key !== '1' && e.key !== '2') return
    if (drawMode && typeof nv.drawAddUndoBitmap === 'function') {
      nv.drawAddUndoBitmap()
      broadcast({ type: 'draw-commit' })
    }
    drawMode = null
    if (nv.canvas) nv.canvas.style.cursor = 'default'
    e.preventDefault()
  })
}

    // rAF loop diffs crosshair position and broadcasts only on change
    function syncLoop() {
      const cur = nv.scene && nv.scene.crosshairPos
      if (!applyingRemote && hasVerifiedPeer() && cur) {
        if (cur[0] !== lastPos[0] || cur[1] !== lastPos[1] || cur[2] !== lastPos[2]) {
          lastPos = [cur[0], cur[1], cur[2]]
          broadcast({ type: 'crosshair', crosshairPos: lastPos })
        }
      }
      requestAnimationFrame(syncLoop)
    }

    function handleCrosshairUpdate(state) {
      if (!state.crosshairPos) return
      applyingRemote = true
      try {
        nv.scene.crosshairPos = new Float32Array(state.crosshairPos)
        // update lastPos here so syncLoop does not re broadcast the remote position
        lastPos = Array.from(state.crosshairPos)
        if (typeof nv.createOnLocationChange === 'function') nv.createOnLocationChange()
        if (typeof nv.drawScene === 'function') nv.drawScene()
      } finally { applyingRemote = false }
    }

    function handleSliceTypeUpdate(state) {
      if (state.sliceType === undefined || nv.opts.sliceType === state.sliceType) return
      applyingRemote = true
      try {
        if (typeof nv.setSliceType === 'function') {
          nv.setSliceType(state.sliceType)
        } else {
          nv.opts.sliceType = state.sliceType
        }
      } finally { applyingRemote = false }
    }

    function handleDrawUpdate(state) {
      if (!state.vox) return
      applyingRemote = true
      try {
        paintAt(state.vox, state.mode === 'erase' ? 'erase' : 'paint', Number(state.brushSize) || brushSize, Number(state.label) || label)
      } finally { applyingRemote = false }
    }

    function handleDrawCommit() {
      ensureDrawBitmap()
      if (!nv.drawBitmap || typeof nv.drawAddUndoBitmap !== 'function') return
      applyingRemote = true
      try { nv.drawAddUndoBitmap() } finally { applyingRemote = false }
    }

    // full bitmap snapshots are sent as raw arraybuffer not json
    function handleDrawSnapshotBinary(data) {
      ensureDrawBitmap()
      if (!nv.drawBitmap || !(data instanceof ArrayBuffer)) return
      const src = new Uint8Array(data)
      if (src.byteLength !== nv.drawBitmap.byteLength) {
        Boostlet.hint('draw snapshot size mismatch', 3000)
        return
      }
      const dst = new Uint8Array(nv.drawBitmap.buffer, nv.drawBitmap.byteOffset, nv.drawBitmap.byteLength)
      applyingRemote = true
      try { dst.set(src); nv.refreshDrawing(true) } finally { applyingRemote = false }
    }

    function getDims() {
      return { dx: nv.back.dims[1], dy: nv.back.dims[2], dz: nv.back.dims[3] }
    }

    function getSliceAxis() {
      const st = nv.opts.sliceType
      if (st === 1) return 1
      if (st === 2) return 0
      return 2
    }

    function getPlaneSize() {
      const { dx, dy, dz } = getDims()
      const axis = getSliceAxis()
      if (axis === 2) return { w: dx, h: dy }
      if (axis === 1) return { w: dx, h: dz }
      return { w: dy, h: dz }
    }

    function toVoxel(x, y, s) {
      const { dx, dy } = getDims()
      const axis = getSliceAxis()
      if (axis === 2) return x + y * dx + s * dx * dy
      if (axis === 1) return x + s * dx + y * dx * dy
      return s + x * dx + y * dx * dy
    }

    function posToPlane(pos) {
      const axis = getSliceAxis()
      if (axis === 2) return { x: pos[0], y: pos[1] }
      if (axis === 1) return { x: pos[0], y: pos[2] }
      return { x: pos[1], y: pos[2] }
    }

    function paintAt(pos, paintMode = drawMode, size = brushSize, drawLabel = label) {
      ensureDrawBitmap()
      if (!nv.drawBitmap) return
      const { x: cx, y: cy } = posToPlane(pos)
      const s = pos[getSliceAxis()]
      const { w, h } = getPlaneSize()
      const val = paintMode === 'paint' ? drawLabel : 0
      for (let dy = -size; dy <= size; dy++) {
        for (let dx = -size; dx <= size; dx++) {
          if (dx * dx + dy * dy > size * size) continue
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || x >= w || y < 0 || y >= h) continue
          nv.drawBitmap[toVoxel(x, y, s)] = val
        }
      }
      nv.refreshDrawing(true)
    }

    function removePeer(peerId) {
      const peer = peers.get(peerId)
      if (peer) {
        if (peer.channel) peer.channel.close()
        peer.conn.close()
        peers.delete(peerId)
        Boostlet.hint('peer disconnected', 2000)
      }
      roomPeers = roomPeers.filter(id => id !== peerId)
      updateCanonicalPeer()
    }
  }

  async function hashVolume(volume) {
    // use volume.img directly not volume.img.buffer to avoid byteOffset issues
    const digest = await crypto.subtle.digest('SHA-256', volume.img)
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  function generateRoomId() {
    const bytes = new Uint8Array(6)
    crypto.getRandomValues(bytes)
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  function onBaseVolumeChanged(nv, callback) {
    let lastRef = null
    // deduplicate calls so the callback only fires when the base volume reference changes
    function emit(base) {
      if (!base || base === lastRef) return
      lastRef = base
      callback(base)
    }
    if (nv.volumes && nv.volumes.length > 0) emit(nv.volumes[0])
    // prefer the event api when available otherwise wrap the callback
    if (typeof nv.addEventListener === 'function') {
      nv.addEventListener('imageLoaded', () => emit(nv.volumes && nv.volumes[0]))
      return
    }
    const prev = nv.onImageLoaded
    nv.onImageLoaded = function (volume) {
      if (prev) prev.call(this, volume)
      emit(nv.volumes && nv.volumes[0])
    }
  }
})()