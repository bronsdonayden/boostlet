;(function () {
  if (window.__boostlet_sync_injected) return
  window.__boostlet_sync_injected = true

  const BOOSTLET_URL = 'https://boostlet.org/dist/boostlet.min.js'
  const SCENE_API = 'https://aydenbronsdon.com/scene'
  const SIGNAL_URL = 'wss://aydenbronsdon.com/signal'

  const CHUNK_SIZE = 65536
  const BUFFER_THRESHOLD = 1048576 // pause sending when buffered amount exceeds 1MB

  window.__sync_send = function (msg) { broadcast(msg) }

  // exposed so boostlets can trigger a volume transfer to all peers after ops
  window.__sync_send_volume = function () { sendVolumeToAll() }

  if (window.Boostlet) {
    waitForNv()
  } else {
    const s = document.createElement('script')
    s.src = BOOSTLET_URL
    s.onload = waitForNv
    document.head.appendChild(s)
  }

  function waitForNv() {
    const poll = setInterval(() => {
      try {
        Boostlet.init()
        if (Boostlet.framework.name !== 'niivue') return
        const nv = Boostlet.framework.instance
        if (!nv || !nv.volumes) return
        clearInterval(poll)
        run(nv)
      } catch (e) {}
    }, 300)
  }

  function run(nv) {
    const code = new URLSearchParams(location.search).get('sync')
    if (code) { joinScene(nv, code) } else { showPanel(nv); hostScene(nv) }
  }

  // volume hashing

  let myHash = null

  async function hashVolume(nv) {
    if (myHash) return myHash
    const vol = nv.volumes && nv.volumes[0]
    if (!vol || !vol.img) return null
    const digest = await crypto.subtle.digest('SHA-256', vol.img)
    myHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
    return myHash
  }

  // scene capture
  // avoids nv.document.json() entirely since on older niivue versions it embeds
  // the full volume buffer even with embedImages=false making the payload huge

  function captureScene(nv) {
    const base = nv.volumes && nv.volumes[0]
    const volumeUrl = base && base.url && !base.url.startsWith('blob:') ? base.url : null
    const volumeData = !volumeUrl && base && base.img ? arrayBufferToBase64(base.img.buffer) : null
    const activeBoostlets = (window.__boostlet_active || []).map(({ name, url }) => ({ name, url }))
    return {
      originUrl: location.href,
      volumeUrl,
      volumeData,
      activeBoostlets,
      crosshairPos: nv.scene ? Array.from(nv.scene.crosshairPos) : [0.5, 0.5, 0.5],
      sliceType: nv.opts ? nv.opts.sliceType : 0,
      colormap: base ? base.colormap : null,
      opacity: base ? base.opacity : 1,
      cal_min: base ? base.cal_min : null,
      cal_max: base ? base.cal_max : null
    }
  }

  function snapState(nv) {
    const b = nv.volumes && nv.volumes[0]
    return {
      crosshairPos: nv.scene ? Array.from(nv.scene.crosshairPos) : [0.5, 0.5, 0.5],
      sliceType: nv.opts ? nv.opts.sliceType : 0,
      colormap: b ? b.colormap : null,
      cal_min: b ? b.cal_min : null,
      cal_max: b ? b.cal_max : null
    }
  }

  async function applyScene(nv, scene) {
    if (scene.volumeUrl && (!nv.volumes || !nv.volumes.length)) {
      try { await nv.loadVolumes([{ url: scene.volumeUrl }]) }
      catch (e) { Boostlet.hint('could not load volume from url', 4000) }
    } else if (scene.volumeData && (!nv.volumes || !nv.volumes.length)) {
      try {
        const blob = new Blob([base64ToArrayBuffer(scene.volumeData)])
        await nv.loadVolumes([{ url: URL.createObjectURL(blob), name: 'shared.nii' }])
      } catch (e) { Boostlet.hint('could not load embedded volume', 4000) }
    }
    if (nv.volumes && nv.volumes.length) applyDiff(nv, scene)
  }

  function applyDiff(nv, diff) {
    if (diff.crosshairPos) {
      nv.scene.crosshairPos = new Float32Array(diff.crosshairPos)
      nv.drawScene && nv.drawScene()
    }
    if (diff.sliceType !== undefined && nv.opts.sliceType !== diff.sliceType) {
      nv.setSliceType && nv.setSliceType(diff.sliceType)
    }
    if (nv.volumes && nv.volumes[0]) {
      const vol = nv.volumes[0]
      let needsUpdate = false
      if (diff.colormap && diff.colormap !== vol.colormap) { nv.setColormap && nv.setColormap(vol.id, diff.colormap); needsUpdate = true }
      if (diff.cal_min !== null && diff.cal_min !== undefined) { vol.cal_min = diff.cal_min; needsUpdate = true }
      if (diff.cal_max !== null && diff.cal_max !== undefined) { vol.cal_max = diff.cal_max; needsUpdate = true }
      if (needsUpdate) nv.updateGLVolume && nv.updateGLVolume()
    }
  }

  // host path

  async function hostScene(nv) {
    const scene = captureScene(nv)
    let code
    try {
      const data = await fetch(SCENE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scene) }).then(r => r.json())
      code = data.code
    } catch (e) { Boostlet.hint('could not reach sync server', 4000); return }

    const next = new URLSearchParams(location.search)
    next.set('sync', code)
    history.replaceState(null, '', `${location.pathname}?${next}${location.hash}`)

    updatePanel(code)
    connectToRoom(nv, code)

    // periodically patch the server snapshot so late joiners get a recent scene
    // skips volumeData to avoid sending the full volume buffer every 3s
    setInterval(() => {
      const s = captureScene(nv)
      delete s.volumeData
      fetch(`${SCENE_API}/${code}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).catch(() => {})
    }, 3000)
  }

  // joiner path

  async function joinScene(nv, code) {
    let scene
    try {
      const res = await fetch(`${SCENE_API}/${code}`)
      if (!res.ok) throw new Error()
      scene = await res.json()
    } catch (e) {
      Boostlet.hint(`sync code ${code} not found`, 4000)
      showPanel(nv); hostScene(nv); return
    }

    if (scene.originUrl && !isSamePage(scene.originUrl, location.href)) {
      const target = new URL(scene.originUrl)
      target.searchParams.set('sync', code)
      location.href = target.toString()
      return
    }

    await applyScene(nv, scene)
    updatePanel(code)
    if (scene.activeBoostlets && scene.activeBoostlets.length) promptBoostlets(scene.activeBoostlets)
    connectToRoom(nv, code)
  }

  // chunked volume transfer
  // chunks are sent as binary ArrayBuffers with a 12 byte header:
  // bytes 0-3: transfer id (uint32)
  // bytes 4-7: chunk index (uint32)
  // bytes 8-11: total chunks (uint32)
  // bytes 12+: chunk data

  const incomingTransfers = new Map()
  let pendingVolumeMeta = null

  function buildNifti1(meta, voxelData) {
    // nifti1 header is 348 bytes + 4 byte extension block = 352 bytes before voxel data
    const hdrBuf = new ArrayBuffer(352)
    const d = new DataView(hdrBuf)
    const bytes = new Uint8Array(hdrBuf)

    // sizeof_hdr
    d.setInt32(0, 348, true)

    // dims: dims[0] = number of dimensions, then x y z etc
    const dims = meta.dims
    for (let i = 0; i < 8; i++) d.setInt16(40 + i * 2, dims[i] || 0, true)

    // datatype and bitpix
    const datatype = meta.datatype || 16 // 16 = float32
    d.setInt16(70, datatype, true)
    const bitsPerVoxel = datatype === 16 ? 32 : datatype === 4 ? 16 : datatype === 8 ? 32 : 8
    d.setInt16(72, bitsPerVoxel, true)

    // pixdims
    const pixDims = meta.pixDims
    for (let i = 0; i < 8; i++) d.setFloat32(76 + i * 4, pixDims[i] || 1, true)

    // vox_offset: where voxel data starts
    d.setFloat32(108, 352, true)

    // scl_slope and scl_inter
    d.setFloat32(112, meta.scl_slope || 1, true)
    d.setFloat32(116, meta.scl_inter || 0, true)

    // qform and sform codes
    d.setInt16(252, meta.qform_code || 1, true)
    d.setInt16(254, meta.sform_code || 1, true)

    // srow affine (3 rows of 4 floats at offset 280)
    if (meta.affine) {
      const aff = meta.affine
      for (let i = 0; i < 12; i++) d.setFloat32(280 + i * 4, aff[i] || 0, true)
    }

    // magic: ni1\0 for single file nifti
    bytes[344] = 110; bytes[345] = 105; bytes[346] = 49; bytes[347] = 0

    // extension block: 4 zero bytes
    // already zero from ArrayBuffer

    // combine header and voxel data
    const nifti = new Uint8Array(352 + voxelData.byteLength)
    nifti.set(new Uint8Array(hdrBuf), 0)
    nifti.set(new Uint8Array(voxelData.buffer, voxelData.byteOffset, voxelData.byteLength), 352)
    return nifti
  }

  function sendVolumeToAll() {
    peers.forEach((peer, peerId) => {
      if (peer.verified && peer.channel && peer.channel.readyState === 'open') {
        sendVolumeToPeer(peer)
      }
    })
  }

  async function sendVolumeToPeer(peer) {
    const vol = nvRef && nvRef.volumes && nvRef.volumes[0]
    if (!vol || !vol.img) return

    // send header metadata first so receiver can reconstruct a valid nifti file
    const hdr = vol.hdr
    try {
      peer.channel.send(JSON.stringify({
        type: 'volume-meta',
        dims: Array.from(hdr.dims),
        pixDims: Array.from(hdr.pixDims),
        datatype: hdr.datatypeCode,
        scl_slope: hdr.scl_slope,
        scl_inter: hdr.scl_inter,
        sform_code: hdr.sform_code,
        qform_code: hdr.qform_code,
        affine: hdr.affine ? Array.from(hdr.affine.flat ? hdr.affine.flat() : hdr.affine) : null
      }))
    } catch (e) { return }

    const data = vol.img
    const totalChunks = Math.ceil(data.byteLength / CHUNK_SIZE)
    const transferId = Math.floor(Math.random() * 0xFFFFFFFF)

    Boostlet.hint(`sending volume to peer  ${totalChunks} chunks`, 2000)

    for (let i = 0; i < totalChunks; i++) {
      // pause and wait for buffer to drain if it gets too full
      while (peer.channel.bufferedAmount > BUFFER_THRESHOLD) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      if (peer.channel.readyState !== 'open') break

      const chunkStart = i * CHUNK_SIZE
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, data.byteLength)
      const chunkData = data.slice(chunkStart, chunkEnd)

      // pack header + chunk into a single arraybuffer
      const packet = new ArrayBuffer(12 + chunkData.byteLength)
      const header = new DataView(packet)
      header.setUint32(0, transferId)
      header.setUint32(4, i)
      header.setUint32(8, totalChunks)
      new Uint8Array(packet, 12).set(new Uint8Array(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength))

      try { peer.channel.send(packet) } catch (e) { break }

      // show progress every 10%
      if (i % Math.max(1, Math.floor(totalChunks / 10)) === 0) {
        Boostlet.hint(`sending volume  ${Math.round(i / totalChunks * 100)}%`, 500)
      }
    }
  }

  function receiveChunk(buffer) {
    if (buffer.byteLength < 12) return

    const header = new DataView(buffer)
    const transferId = header.getUint32(0)
    const chunkIndex = header.getUint32(4)
    const totalChunks = header.getUint32(8)
    const chunkData = buffer.slice(12)

    if (!incomingTransfers.has(transferId)) {
      incomingTransfers.set(transferId, { chunks: new Array(totalChunks), received: 0, total: totalChunks })
    }

    const transfer = incomingTransfers.get(transferId)
    transfer.chunks[chunkIndex] = chunkData
    transfer.received++

    // show progress every 10%
    if (transfer.received % Math.max(1, Math.floor(totalChunks / 10)) === 0) {
      Boostlet.hint(`receiving volume  ${Math.round(transfer.received / totalChunks * 100)}%`, 500)
    }

    if (transfer.received === transfer.total) {
      incomingTransfers.delete(transferId)
      assembleVolume(transfer.chunks)
    }
  }

  function assembleVolume(chunks) {
    const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const assembled = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      assembled.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }

    const vol = nvRef && nvRef.volumes && nvRef.volumes[0]

    if (vol && vol.img && vol.img.byteLength === assembled.byteLength) {
      // volume already loaded and same size so write directly into it
      vol.img.set(assembled)
      nvRef.updateGLVolume && nvRef.updateGLVolume()
      myHash = null
      Boostlet.hint('volume received', 2000)
    } else if (pendingVolumeMeta) {
      // no volume loaded so build a valid nifti file from the received header metadata
      const nifti = buildNifti1(pendingVolumeMeta, assembled)
      pendingVolumeMeta = null
      const blob = new Blob([nifti], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      nvRef.loadVolumes([{ url, name: 'received.nii' }]).then(() => {
        URL.revokeObjectURL(url)
        myHash = null
        Boostlet.hint('volume received', 2000)
      }).catch(() => { Boostlet.hint('could not load received volume', 4000) })
    } else {
      Boostlet.hint('no volume metadata received', 4000)
    }
  }

  // webrtc mesh

  const peers = new Map()
  let selfId = null, roomPeers = [], signal = null, nvRef = null
  let applyingRemote = false

  function connectToRoom(nv, code) {
    nvRef = nv
    signal = new WebSocket(`${SIGNAL_URL}?room=${encodeURIComponent(code)}`)
    signal.onerror = () => Boostlet.hint('could not reach signal server', 4000)
    signal.onmessage = async (raw) => {
      let msg; try { msg = JSON.parse(raw.data) } catch { return }
      try {
        if (msg.type === 'room-state') { selfId = msg.peerId; roomPeers = msg.peers.concat(selfId); return }
        if (msg.type === 'peer-joined') { if (!roomPeers.includes(msg.peerId)) roomPeers.push(msg.peerId); await makeOffer(msg.peerId); return }
        if (msg.type === 'peer-disconnected') { removePeer(msg.peerId); return }
        if (!msg.from) return
        if (msg.type === 'offer') await handleOffer(msg.from, msg.payload)
        if (msg.type === 'answer') await handleAnswer(msg.from, msg.payload)
        if (msg.type === 'ice') await handleIce(msg.from, msg.payload)
      } catch (e) {}
    }

    // both host and joiner broadcast diffs so sync works in both directions
    startBroadcasting(nv)
  }

  // rAF loop that diffs individual fields and broadcasts only what changed
  // each field is its own message type so the receiver applies just that field
  // throttled to 33ms minimum between crosshair broadcasts to avoid flooding

  function startBroadcasting(nv) {
    let last = { crosshairPos: null, sliceType: null, colormap: null, cal_min: null, cal_max: null }
    let lastCrosshairBroadcast = 0

    const tick = () => {
      if (!applyingRemote) {
        const cur = snapState(nv)
        const now = Date.now()

        // throttle crosshair to 30fps max to avoid flooding the channel
        if (cur.crosshairPos && (!last.crosshairPos ||
          cur.crosshairPos[0] !== last.crosshairPos[0] ||
          cur.crosshairPos[1] !== last.crosshairPos[1] ||
          cur.crosshairPos[2] !== last.crosshairPos[2]) &&
          now - lastCrosshairBroadcast >= 33) {
          last.crosshairPos = cur.crosshairPos
          lastCrosshairBroadcast = now
          broadcast({ type: 'crosshair', crosshairPos: cur.crosshairPos })
        }

        if (cur.sliceType !== last.sliceType) {
          last.sliceType = cur.sliceType
          broadcast({ type: 'sliceType', sliceType: cur.sliceType })
        }

        if (cur.colormap !== last.colormap) {
          last.colormap = cur.colormap
          broadcast({ type: 'colormap', colormap: cur.colormap })
        }

        if (cur.cal_min !== last.cal_min || cur.cal_max !== last.cal_max) {
          last.cal_min = cur.cal_min
          last.cal_max = cur.cal_max
          broadcast({ type: 'calRange', cal_min: cur.cal_min, cal_max: cur.cal_max })
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  async function makeOffer(peerId) {
    if (!peerId || peerId === selfId) return
    const peer = getPeer(peerId, true)
    if (peer.conn.signalingState !== 'stable') return
    const offer = await peer.conn.createOffer()
    await peer.conn.setLocalDescription(offer)
    sendSignal('offer', peerId, offer)
  }

  async function handleOffer(peerId, offer) {
    const peer = getPeer(peerId, false)
    await peer.conn.setRemoteDescription(offer); peer.remoteDescSet = true; await flushCandidates(peer)
    const answer = await peer.conn.createAnswer()
    await peer.conn.setLocalDescription(answer)
    sendSignal('answer', peerId, answer)
  }

  async function handleAnswer(peerId, answer) {
    const peer = peers.get(peerId); if (!peer) return
    await peer.conn.setRemoteDescription(answer); peer.remoteDescSet = true; await flushCandidates(peer)
  }

  async function handleIce(peerId, candidate) {
    if (!candidate || !peers.has(peerId)) return
    const peer = peers.get(peerId)
    if (peer.remoteDescSet) { await peer.conn.addIceCandidate(candidate) } else { peer.pendingCandidates.push(candidate) }
  }

  async function flushCandidates(peer) {
    for (const c of peer.pendingCandidates) await peer.conn.addIceCandidate(c)
    peer.pendingCandidates = []
  }

  function getPeer(peerId, createChannel) {
    if (peers.has(peerId)) return peers.get(peerId)
    const conn = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    const peer = { conn, channel: null, pendingCandidates: [], remoteDescSet: false, verified: false }
    peers.set(peerId, peer)
    conn.onicecandidate = (e) => { if (e.candidate) sendSignal('ice', peerId, e.candidate) }
    conn.ondatachannel = (e) => wireChannel(peerId, e.channel)
    conn.onconnectionstatechange = () => { if (conn.connectionState === 'failed' || conn.connectionState === 'closed') removePeer(peerId) }
    if (createChannel) wireChannel(peerId, conn.createDataChannel('boostlet-sync'))
    return peer
  }

  function wireChannel(peerId, channel) {
    const peer = peers.get(peerId); if (!peer) { channel.close(); return }
    peer.channel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = async () => {
      const hash = await hashVolume(nvRef)
      if (hash) { try { channel.send(JSON.stringify({ type: 'hash-check', hash })) } catch (e) {} }
      else { peer.verified = true; Boostlet.hint('peer connected', 2000) }
    }

    channel.onmessage = (e) => {
      // binary messages are volume chunks, string messages are json
      if (e.data instanceof ArrayBuffer) {
        if (peer.verified) receiveChunk(e.data)
        return
      }

      let msg; try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'hash-check') { handleHashCheck(peerId, msg.hash); return }
      if (!peer.verified) return

      // store incoming volume metadata for use when chunks finish assembling
      if (msg.type === 'volume-meta') { pendingVolumeMeta = msg; return }

      if (msg.type === 'crosshair' || msg.type === 'sliceType' || msg.type === 'colormap' || msg.type === 'calRange') {
        applyingRemote = true
        applyDiff(nvRef, {
          crosshairPos: msg.crosshairPos,
          sliceType: msg.sliceType,
          colormap: msg.colormap,
          cal_min: msg.cal_min,
          cal_max: msg.cal_max
        })
        setTimeout(() => { applyingRemote = false }, 0)
        return
      }

      routeMessage(msg)
    }

    channel.onclose = () => { if (peer.channel === channel) { peer.channel = null; peer.verified = false } }
  }

  async function handleHashCheck(peerId, remoteHash) {
    const peer = peers.get(peerId); if (!peer) return
    const localHash = await hashVolume(nvRef)
    if (!localHash) { Boostlet.hint('load a volume to enable boostlet sync', 4000); return }
    peer.verified = localHash === remoteHash
    Boostlet.hint(peer.verified ? 'peer connected  volumes match' : 'peer volume mismatch  boostlet sync disabled', peer.verified ? 2000 : 5000)
  }

  function routeMessage(msg) {
    if (!msg || !msg.type) return
    for (const entry of (window.__boostlet_active || [])) {
      if (typeof entry.onMessage === 'function') entry.onMessage(msg)
    }
  }

  function broadcast(msg) {
    const str = JSON.stringify(msg)
    peers.forEach(peer => {
      if (peer.verified && peer.channel && peer.channel.readyState === 'open') {
        try { peer.channel.send(str) } catch (e) {}
      }
    })
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId)
    if (peer) { if (peer.channel) peer.channel.close(); peer.conn.close(); peers.delete(peerId); Boostlet.hint('peer disconnected', 2000) }
    roomPeers = roomPeers.filter(id => id !== peerId)
  }

  function sendSignal(type, to, payload) {
    if (signal && signal.readyState === WebSocket.OPEN) signal.send(JSON.stringify({ type, to, payload }))
  }

  // ui

  const PANEL_CSS = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#111;border:1.5px solid #444;border-radius:8px;padding:10px 12px;font-family:monospace;font-size:12px;color:#ccc;box-shadow:0 4px 16px rgba(0,0,0,.6);min-width:180px'
  const BTN_CSS = 'border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-family:monospace;font-size:11px'

  function el(tag, css, text) {
    const e = document.createElement(tag)
    if (css) e.style.cssText = css
    if (text) e.textContent = text
    return e
  }

  function showPanel(nv) {
    if (document.getElementById('__sync_panel')) return
    const panel = el('div', PANEL_CSS)
    panel.id = '__sync_panel'

    const close = el('button', 'position:absolute;top:6px;right:8px;background:none;border:none;color:#666;font-size:14px;cursor:pointer', '×')
    close.onclick = () => panel.remove()

    const status = el('div', 'font-size:11px;color:#666', 'starting...')
    status.id = '__sync_status'

    const input = el('input', 'background:#222;color:#fff;border:1px solid #444;border-radius:4px;padding:4px 6px;font-family:monospace;font-size:12px;width:70px;outline:none')
    input.placeholder = 'xxxxx'; input.maxLength = 8

    const joinBtn = el('button', `${BTN_CSS};background:#1a3a6a;color:#fff`, 'join')
    joinBtn.onclick = () => {
      const code = input.value.trim().toLowerCase()
      if (!code) return
      joinBtn.disabled = true
      joinScene(nv, code).catch(() => { joinBtn.disabled = false })
    }
    input.onkeydown = (e) => { if (e.key === 'Enter') joinBtn.click() }

    const row = el('div', 'display:flex;gap:6px')
    row.append(input, joinBtn)

    panel.append(
      close,
      el('div', 'font-size:11px;color:#888;letter-spacing:.05em', 'boostlet sync'),
      status,
      el('div', 'border-top:1px solid #333;margin:2px 0'),
      el('div', 'font-size:11px;color:#888', 'join with code'),
      row
    )
    document.body.appendChild(panel)
  }

  function updatePanel(code) {
    const shareUrl = `${location.origin}${location.pathname}?sync=${code}`
    const status = document.getElementById('__sync_status')
    if (!status) return

    const copyBtn = el('button', `${BTN_CSS};background:#1a3a1a;color:#8c8;border:1px solid #4a4`, 'copy link')
    copyBtn.onclick = () => navigator.clipboard.writeText(shareUrl).then(() => {
      copyBtn.textContent = 'copied'
      setTimeout(() => { copyBtn.textContent = 'copy link' }, 1500)
    })

    const sendVolBtn = el('button', `${BTN_CSS};background:#222;color:#aaa;border:1px solid #555;margin-top:2px`, 'send volume to peers')
    sendVolBtn.onclick = () => {
      sendVolBtn.disabled = true
      sendVolBtn.textContent = 'sending...'
      window.__sync_send_volume()
      setTimeout(() => { sendVolBtn.disabled = false; sendVolBtn.textContent = 'send volume to peers' }, 3000)
    }

    const row = el('div', 'display:flex;flex-direction:column;gap:6px')
    const codeRow = el('div', 'display:flex;align-items:center;gap:8px')
    codeRow.append(el('span', 'color:#4a4;letter-spacing:.1em;font-size:13px', code), copyBtn)
    row.append(codeRow, sendVolBtn)
    status.replaceWith(row)
  }

  function promptBoostlets(boostlets) {
    const missing = boostlets.filter(b => !(window.__boostlet_active || []).find(a => a.name === b.name))
    if (!missing.length) return

    const prompt = el('div', 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#111;border:1.5px solid #444;border-radius:8px;padding:12px 16px;font-family:monospace;font-size:12px;color:#ccc;box-shadow:0 4px 16px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:8px;max-width:320px')
    prompt.append(el('div', 'font-size:11px;color:#888', 'host has these boostlets active'))

    for (const b of missing) {
      const btn = el('button', `${BTN_CSS};background:#1a3a6a;color:#fff`, 'load')
      btn.onclick = () => { Boostlet.load_script(b.url, () => {}); btn.textContent = 'loaded'; btn.disabled = true }
      const row = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:12px')
      row.append(el('span', null, b.name), btn)
      prompt.appendChild(row)
    }

    const dismiss = el('button', `${BTN_CSS};background:none;border:1px solid #444;color:#666;align-self:flex-end`, 'dismiss')
    dismiss.onclick = () => prompt.remove()
    prompt.appendChild(dismiss)
    document.body.appendChild(prompt)
    setTimeout(() => prompt.remove(), 15000)
  }

  // utils

  function isSamePage(a, b) {
    try { return new URL(a).origin + new URL(a).pathname === new URL(b).origin + new URL(b).pathname } catch { return false }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  function base64ToArrayBuffer(b64) {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

})()
