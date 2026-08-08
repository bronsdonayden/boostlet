;(function () {
  if (window.__boostlet_sync_injected && window.__boostlet_sync_signal &&
      window.__boostlet_sync_signal.readyState === WebSocket.OPEN) return
  window.__boostlet_sync_injected = true

  // ===== config =====

  const BOOSTLET_URL = 'https://boostlet.org/dist/boostlet.min.js'
  const SCENE_API = 'https://aydenbronsdon.com/scene'
  const SIGNAL_URL = 'wss://aydenbronsdon.com/signal'
  const CHUNK_SIZE = 65536
  const BUFFER_THRESHOLD = 1048576
  const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

  // ===== state =====

  const state = {
    nv: null,
    signal: null,
    peers: new Map(),
    selfId: null,
    roomPeers: [],
    myHash: null,
    applyingRemote: false,
    patchInterval: null,
    rafId: null,
    pollId: null
  }

  // ===== public api =====

  window.__sync_send = function (msg) { broadcast(msg) }
  window.__sync_send_volume = function () { sendVolumeToAll() }

  window.__boostlet_sync_destroy = function () {
    if (state.pollId) clearInterval(state.pollId)
    if (state.patchInterval) clearInterval(state.patchInterval)
    if (state.rafId) cancelAnimationFrame(state.rafId)
    if (state.signal) state.signal.close()
    state.peers.forEach(peer => {
      if (peer.channel) peer.channel.close()
      peer.conn.close()
    })
    state.peers.clear()
    incomingTransfers.clear()
    pendingMetas.clear()
    const panel = document.getElementById('__sync_panel')
    if (panel) panel.remove()
    window.__boostlet_sync_injected = false
    window.__boostlet_sync_signal = null
  }

  // ===== bootstrap =====

  if (window.Boostlet) {
    waitForNv()
  } else {
    const s = document.createElement('script')
    s.src = BOOSTLET_URL
    s.onload = waitForNv
    document.head.appendChild(s)
  }

  function waitForNv() {
    state.pollId = setInterval(() => {
      try {
        Boostlet.init()
        if (Boostlet.framework.name !== 'niivue') return
        const nv = Boostlet.framework.instance
        if (!nv?.volumes) return
        clearInterval(state.pollId)
        state.pollId = null
        start(nv)
      } catch (e) {}
    }, 300)
  }

  function start(nv) {
    state.nv = nv
    const code = new URLSearchParams(location.search).get('sync')
    if (code) { joinScene(code) } else { showPanel(); hostScene() }
  }

  // ===== scene adapter =====

  async function hashVolume() {
    if (state.myHash) return state.myHash
    const img = state.nv.volumes?.[0]?.img
    if (!img) return null
    const digest = await crypto.subtle.digest('SHA-256', img)
    state.myHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
    return state.myHash
  }

  // full includes volume url and active boostlets for server snapshots
  // volume data is never included since voxel transfer is p2p only
  // lightweight version is used by the broadcast diff loop
  function readScene(full) {
    const nv = state.nv
    const vol = nv.volumes?.[0]
    const snap = {
      crosshairPos: nv.scene ? Array.from(nv.scene.crosshairPos) : [0.5, 0.5, 0.5],
      sliceType: nv.opts?.sliceType ?? 0,
      colormap: vol?.colormap ?? null,
      cal_min: vol?.cal_min ?? null,
      cal_max: vol?.cal_max ?? null
    }
    if (!full) return snap
    return {
      originUrl: location.href,
      volumeUrl: vol?.url && !vol.url.startsWith('blob:') ? vol.url : null,
      activeBoostlets: (window.__boostlet_active || []).map(({ name, url }) => ({ name, url })),
      ...snap
    }
  }

  function applyDiff(diff) {
    const nv = state.nv
    if (diff.crosshairPos) {
      nv.scene.crosshairPos = new Float32Array(diff.crosshairPos)
      nv.drawScene?.()
    }
    if (diff.sliceType !== undefined && nv.opts.sliceType !== diff.sliceType) {
      nv.setSliceType?.(diff.sliceType)
    }
    const vol = nv.volumes?.[0]
    if (!vol) return
    let needsUpdate = false
    if (diff.colormap && diff.colormap !== vol.colormap) { nv.setColormap?.(vol.id, diff.colormap); needsUpdate = true }
    if (diff.cal_min != null) { vol.cal_min = diff.cal_min; needsUpdate = true }
    if (diff.cal_max != null) { vol.cal_max = diff.cal_max; needsUpdate = true }
    if (needsUpdate) nv.updateGLVolume?.()
  }

  async function applyScene(scene) {
    const nv = state.nv
    if (scene.volumeUrl && !nv.volumes?.length) {
      try { await nv.loadVolumes([{ url: scene.volumeUrl }]) }
      catch (e) { Boostlet.hint('could not load volume from url', 4000) }
    }
    if (nv.volumes?.length) applyDiff(scene)
    if (!nv.volumes?.length && !scene.volumeUrl) {
      Boostlet.hint('waiting for host to share volume', 4000)
    }
  }

  // ===== host and join =====

  async function hostScene() {
    const scene = readScene(true)
    let code
    try {
      const data = await fetch(SCENE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scene) }).then(r => r.json())
      code = data.code
    } catch (e) { Boostlet.hint('could not reach sync server', 4000); return }

    const params = new URLSearchParams(location.search)
    params.set('sync', code)
    history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`)

    updatePanel(code)
    connectToRoom(code)

    // patch server snapshot so late joiners get recent display state
    state.patchInterval = setInterval(() => {
      const s = readScene(false)
      s.activeBoostlets = (window.__boostlet_active || []).map(({ name, url }) => ({ name, url }))
      fetch(`${SCENE_API}/${code}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).catch(() => {})
    }, 3000)
  }

  async function joinScene(code) {
    let scene
    try {
      const res = await fetch(`${SCENE_API}/${code}`)
      if (!res.ok) throw new Error()
      scene = await res.json()
    } catch (e) {
      Boostlet.hint(`sync code ${code} not found`, 4000)
      showPanel(); hostScene(); return
    }

    if (scene.originUrl && !isSamePage(scene.originUrl, location.href)) {
      const target = new URL(scene.originUrl)
      target.searchParams.set('sync', code)
      location.href = target.toString()
      return
    }

    await applyScene(scene)
    updatePanel(code)
    if (scene.activeBoostlets?.length) promptBoostlets(scene.activeBoostlets)
    connectToRoom(code)
  }

  // ===== volume transfer =====

  const incomingTransfers = new Map()
  const pendingMetas = new Map()

  function buildNifti1(meta, voxelData) {
    const hdrBuf = new ArrayBuffer(352)
    const d = new DataView(hdrBuf)

    d.setInt32(0, 348, true)
    for (let i = 0; i < 8; i++) d.setInt16(40 + i * 2, meta.dims[i] || 0, true)

    d.setInt16(70, meta.datatypeCode || 16, true)
    d.setInt16(72, meta.numBitsPerVoxel || 32, true)

    for (let i = 0; i < 8; i++) d.setFloat32(76 + i * 4, meta.pixDims[i] || 1, true)

    d.setFloat32(108, 352, true)
    d.setFloat32(112, meta.scl_slope || 1, true)
    d.setFloat32(116, meta.scl_inter || 0, true)
    d.setInt16(252, meta.qform_code || 1, true)
    d.setInt16(254, meta.sform_code || 1, true)

    if (meta.affine) {
      let k = 0
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 4; j++)
          d.setFloat32(280 + (k++) * 4, meta.affine[i][j] || 0, true)
    }

    // magic n+1\0 for single file nifti1
    const bytes = new Uint8Array(hdrBuf)
    bytes[344] = 110; bytes[345] = 43; bytes[346] = 49; bytes[347] = 0

    const nifti = new Uint8Array(352 + voxelData.byteLength)
    nifti.set(bytes, 0)
    nifti.set(new Uint8Array(voxelData.buffer, voxelData.byteOffset, voxelData.byteLength), 352)
    return nifti
  }

  // volume transfer goes to any peer with an open channel
  // not gated on verified because the whole point of sending volume
  // is to fix a mismatch or share with a peer that has nothing loaded
  function sendVolumeToAll() {
    state.peers.forEach(peer => {
      if (peer.channel?.readyState === 'open') sendVolumeToPeer(peer)
    })
  }

  async function sendVolumeToPeer(peer) {
    const vol = state.nv.volumes?.[0]
    if (!vol?.img) return

    const arr = new Uint8Array(crypto.getRandomValues(new Uint8Array(4)).buffer)
    const transferId = new DataView(arr.buffer).getUint32(0)

    try {
      peer.channel.send(JSON.stringify({
        type: 'volume-meta',
        transferId,
        dims: Array.from(vol.hdr.dims),
        pixDims: Array.from(vol.hdr.pixDims),
        datatypeCode: vol.hdr.datatypeCode,
        numBitsPerVoxel: vol.hdr.numBitsPerVoxel,
        scl_slope: vol.hdr.scl_slope,
        scl_inter: vol.hdr.scl_inter,
        sform_code: vol.hdr.sform_code,
        qform_code: vol.hdr.qform_code,
        affine: vol.hdr.affine
      }))
    } catch (e) { return }

    const data = new Uint8Array(vol.img.buffer, vol.img.byteOffset, vol.img.byteLength)
    const totalChunks = Math.ceil(data.byteLength / CHUNK_SIZE)

    Boostlet.hint(`sending volume to peer  ${totalChunks} chunks`, 2000)

    for (let i = 0; i < totalChunks; i++) {
      while (peer.channel.bufferedAmount > BUFFER_THRESHOLD) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (peer.channel.readyState !== 'open') break

      const start = i * CHUNK_SIZE
      const chunk = data.slice(start, Math.min(start + CHUNK_SIZE, data.byteLength))

      const packet = new ArrayBuffer(12 + chunk.byteLength)
      const hdr = new DataView(packet)
      hdr.setUint32(0, transferId)
      hdr.setUint32(4, i)
      hdr.setUint32(8, totalChunks)
      new Uint8Array(packet, 12).set(chunk)

      try { peer.channel.send(packet) } catch (e) { break }

      if (i % Math.max(1, Math.floor(totalChunks / 10)) === 0) {
        Boostlet.hint(`sending volume  ${Math.round(i / totalChunks * 100)}%`, 500)
      }
    }
  }

  function receiveChunk(buffer) {
    if (buffer.byteLength < 12) return

    const hdr = new DataView(buffer)
    const transferId = hdr.getUint32(0)
    const chunkIndex = hdr.getUint32(4)
    const totalChunks = hdr.getUint32(8)

    if (!incomingTransfers.has(transferId)) {
      incomingTransfers.set(transferId, { transferId, chunks: new Array(totalChunks), received: 0, total: totalChunks })
    }

    const transfer = incomingTransfers.get(transferId)

    // guard duplicate chunks
    if (transfer.chunks[chunkIndex]) return
    transfer.chunks[chunkIndex] = buffer.slice(12)
    transfer.received++

    if (transfer.received % Math.max(1, Math.floor(totalChunks / 10)) === 0) {
      Boostlet.hint(`receiving volume  ${Math.round(transfer.received / totalChunks * 100)}%`, 500)
    }

    if (transfer.received === transfer.total) {
      incomingTransfers.delete(transferId)
      assembleVolume(transfer)
    }
  }

  function assembleVolume(transfer) {
    const totalBytes = transfer.chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const assembled = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of transfer.chunks) {
      assembled.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }

    const nv = state.nv
    const vol = nv.volumes?.[0]

    // pull metadata keyed by this transfer id
    const meta = pendingMetas.get(transfer.transferId)
    if (meta) pendingMetas.delete(transfer.transferId)

    if (!meta && vol?.img && vol.img.byteLength === assembled.byteLength) {
      // raw voxel overwrite for same size volume
      vol.img.set(assembled)
      nv.updateGLVolume?.()
      nv.drawScene?.()
      state.myHash = null
      Boostlet.hint('volume received', 2000)
    } else if (meta) {
      const nifti = buildNifti1(meta, assembled)
      const blob = new Blob([nifti], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      nv.loadVolumes([{ url, name: 'received.nii' }]).then(() => {
        URL.revokeObjectURL(url)
        nv.drawScene?.()
        state.myHash = null
        Boostlet.hint('volume received', 2000)
      }).catch(() => { Boostlet.hint('could not load received volume', 4000) })
    } else {
      Boostlet.hint('could not load received volume', 4000)
    }
  }

  // ===== rtc room =====

  function connectToRoom(code) {
    const ws = new WebSocket(`${SIGNAL_URL}?room=${encodeURIComponent(code)}`)
    state.signal = ws
    window.__boostlet_sync_signal = ws

    ws.onerror = () => Boostlet.hint('could not reach signal server', 4000)

    const handlers = {
      'room-state': (msg) => { state.selfId = msg.peerId; state.roomPeers = msg.peers.concat(state.selfId) },
      'peer-joined': (msg) => { if (!state.roomPeers.includes(msg.peerId)) state.roomPeers.push(msg.peerId); makeOffer(msg.peerId) },
      'peer-disconnected': (msg) => removePeer(msg.peerId),
      'offer': (msg) => handleOffer(msg.from, msg.payload),
      'answer': (msg) => handleAnswer(msg.from, msg.payload),
      'ice': (msg) => handleIce(msg.from, msg.payload)
    }

    ws.onmessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.data) } catch { return }
      const handler = handlers[msg.type]
      if (handler) Promise.resolve(handler(msg)).catch(() => {})
    }

    startBroadcasting()
  }

  // diffs current scene against last known state every frame
  // broadcasts a single scene patch with only changed fields
  // crosshair is throttled to 30fps to avoid flooding the channel
  // when applying remote changes the baseline is updated without broadcasting
  // so the next local diff does not echo back what was just received

  function startBroadcasting() {
    let last = { crosshairPos: null, sliceType: null, colormap: null, cal_min: null, cal_max: null }
    let lastCrosshairBroadcast = 0

    const tick = () => {
      state.rafId = requestAnimationFrame(tick)

      const cur = readScene(false)

      // when applying remote diffs just update baseline so no false diff fires
      if (state.applyingRemote) {
        last = cur
        return
      }

      const now = Date.now()
      const patch = {}

      const crosshairChanged = cur.crosshairPos && (!last.crosshairPos ||
          cur.crosshairPos.some((v, i) => v !== last.crosshairPos[i]))
      if (crosshairChanged && now - lastCrosshairBroadcast >= 33) {
        patch.crosshairPos = cur.crosshairPos
        last.crosshairPos = cur.crosshairPos
        lastCrosshairBroadcast = now
      }

      if (cur.sliceType !== last.sliceType) {
        patch.sliceType = cur.sliceType; last.sliceType = cur.sliceType
      }
      if (cur.colormap !== last.colormap) {
        patch.colormap = cur.colormap; last.colormap = cur.colormap
      }
      if (cur.cal_min !== last.cal_min || cur.cal_max !== last.cal_max) {
        patch.cal_min = cur.cal_min; patch.cal_max = cur.cal_max
        last.cal_min = cur.cal_min; last.cal_max = cur.cal_max
      }

      if (Object.keys(patch).length) broadcast({ type: 'scene-patch', patch })
    }
    state.rafId = requestAnimationFrame(tick)
  }

  async function makeOffer(peerId) {
    if (!peerId || peerId === state.selfId) return
    const peer = getPeer(peerId, true)
    if (peer.conn.signalingState !== 'stable') return
    const offer = await peer.conn.createOffer()
    await peer.conn.setLocalDescription(offer)
    sendSignal('offer', peerId, offer)
  }

  async function handleOffer(peerId, offer) {
    const peer = getPeer(peerId, false)
    await peer.conn.setRemoteDescription(offer)
    peer.remoteDescSet = true
    await flushCandidates(peer)
    const answer = await peer.conn.createAnswer()
    await peer.conn.setLocalDescription(answer)
    sendSignal('answer', peerId, answer)
  }

  async function handleAnswer(peerId, answer) {
    const peer = state.peers.get(peerId)
    if (!peer) return
    await peer.conn.setRemoteDescription(answer)
    peer.remoteDescSet = true
    await flushCandidates(peer)
  }

  async function handleIce(peerId, candidate) {
    if (!candidate) return
    const peer = state.peers.get(peerId)
    if (!peer) return
    if (peer.remoteDescSet) await peer.conn.addIceCandidate(candidate)
    else peer.pendingCandidates.push(candidate)
  }

  async function flushCandidates(peer) {
    for (const c of peer.pendingCandidates) await peer.conn.addIceCandidate(c)
    peer.pendingCandidates = []
  }

  function getPeer(peerId, createChannel) {
    if (state.peers.has(peerId)) return state.peers.get(peerId)
    const conn = new RTCPeerConnection(ICE_CONFIG)
    const peer = { conn, channel: null, pendingCandidates: [], remoteDescSet: false, verified: false }
    state.peers.set(peerId, peer)
    conn.onicecandidate = (e) => { if (e.candidate) sendSignal('ice', peerId, e.candidate) }
    conn.ondatachannel = (e) => wireChannel(peerId, e.channel)
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === 'failed' || conn.connectionState === 'closed') removePeer(peerId)
    }
    if (createChannel) wireChannel(peerId, conn.createDataChannel('boostlet-sync'))
    return peer
  }

  function wireChannel(peerId, channel) {
    const peer = state.peers.get(peerId)
    if (!peer) { channel.close(); return }
    peer.channel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = async () => {
      const hash = await hashVolume()
      if (hash) {
        try { channel.send(JSON.stringify({ type: 'hash-hello', hash })) } catch (e) {}
      } else {
        // no volume loaded so accept immediately
        peer.verified = true
        try { channel.send(JSON.stringify({ type: 'hash-result', match: true })) } catch (e) {}
        Boostlet.hint('peer connected', 2000)
      }
    }

    channel.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) { receiveChunk(e.data); return }

      let msg; try { msg = JSON.parse(e.data) } catch { return }

      // hash handshake is hello then result with no further replies
      if (msg.type === 'hash-hello') { handleHashHello(peerId, msg.hash); return }
      if (msg.type === 'hash-result') {
        peer.verified = msg.match
        Boostlet.hint(msg.match ? 'peer connected' : 'peer volume mismatch', msg.match ? 2000 : 5000)
        return
      }

      // volume metadata is keyed by transfer id so concurrent transfers stay paired
      if (msg.type === 'volume-meta') { pendingMetas.set(msg.transferId, msg); return }

      if (!peer.verified) return

      if (msg.type === 'scene-patch') {
        state.applyingRemote = true
        applyDiff(msg.patch)
        setTimeout(() => { state.applyingRemote = false }, 0)
        return
      }

      // anything else goes to the boostlet bus
      routeMessage(msg)
    }

    channel.onclose = () => {
      if (peer.channel === channel) { peer.channel = null; peer.verified = false }
    }
  }

  async function handleHashHello(peerId, remoteHash) {
    const peer = state.peers.get(peerId)
    if (!peer) return
    const localHash = await hashVolume()
    const match = !localHash || localHash === remoteHash
    peer.verified = match
    try { peer.channel.send(JSON.stringify({ type: 'hash-result', match })) } catch (e) {}
    Boostlet.hint(match ? 'peer connected' : 'peer volume mismatch', match ? 2000 : 5000)
  }

  function broadcast(msg) {
    const str = JSON.stringify(msg)
    state.peers.forEach(peer => {
      if (peer.verified && peer.channel?.readyState === 'open') {
        try { peer.channel.send(str) } catch (e) {}
      }
    })
  }

  function removePeer(peerId) {
    const peer = state.peers.get(peerId)
    if (!peer) return
    peer.channel?.close()
    peer.conn.close()
    state.peers.delete(peerId)
    state.roomPeers = state.roomPeers.filter(id => id !== peerId)
    Boostlet.hint('peer disconnected', 2000)
  }

  function sendSignal(type, to, payload) {
    if (state.signal?.readyState === WebSocket.OPEN) {
      state.signal.send(JSON.stringify({ type, to, payload }))
    }
  }

  // ===== boostlet bus =====

  window.__boostlet_active = window.__boostlet_active || []

  window.registerBoostletSync = function (entry) {
    const idx = window.__boostlet_active.findIndex(e => e.name === entry.name)
    if (idx !== -1) window.__boostlet_active[idx] = entry
    else window.__boostlet_active.push(entry)
  }

  function routeMessage(msg) {
    if (!msg?.type) return
    for (const entry of window.__boostlet_active) {
      if (typeof entry.onMessage === 'function') entry.onMessage(msg)
    }
  }

  // ===== sync panel =====

  const PANEL_CSS = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#111;border:1.5px solid #444;border-radius:8px;padding:10px 12px;font-family:monospace;font-size:12px;color:#ccc;box-shadow:0 4px 16px rgba(0,0,0,.6);min-width:180px'
  const BTN_CSS = 'border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-family:monospace;font-size:11px'

  function el(tag, css, text) {
    const e = document.createElement(tag)
    if (css) e.style.cssText = css
    if (text) e.textContent = text
    return e
  }

  function showPanel() {
    if (document.getElementById('__sync_panel')) return
    const panel = el('div', PANEL_CSS)
    panel.id = '__sync_panel'

    const close = el('button', 'position:absolute;top:6px;right:8px;background:none;border:none;color:#666;font-size:14px;cursor:pointer', '\u00d7')
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
      joinScene(code).catch(() => { joinBtn.disabled = false })
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

  // ===== utils =====

  function isSamePage(a, b) {
    try {
      const ua = new URL(a), ub = new URL(b)
      return ua.origin + ua.pathname === ub.origin + ub.pathname
    } catch { return false }
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
