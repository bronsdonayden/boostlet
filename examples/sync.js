;(function () {
  if (window.__boostlet_sync_injected) return
  window.__boostlet_sync_injected = true

  const BOOSTLET_URL = 'https://boostlet.org/dist/boostlet.min.js'
  const SCENE_API = 'https://aydenbronsdon.com/scene'
  const SIGNAL_URL = 'wss://aydenbronsdon.com/signal'

  window.__sync_send = function (msg) { broadcast(msg) }

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

  // snapshot of just the live display fields for diffing in the broadcast loop
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
    // wait until volumes are actually loaded before applying display state
    if (nv.volumes && nv.volumes.length) applyDiff(nv, scene)
  }

  // apply only the display fields from a diff or full scene object
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
  // captures scene once and stores it so the share link reconstructs the exact
  // moment the user clicked share then periodically patches it every 3s
  // all live sync goes through webrtc diff messages not the http store

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
  // fetches the stored scene snapshot and applies it once including volume load
  // then switches entirely to webrtc diff messages for live updates

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

  function startBroadcasting(nv) {
    let last = { crosshairPos: null, sliceType: null, colormap: null, cal_min: null, cal_max: null }

    const tick = () => {
      if (!applyingRemote) {
        const cur = snapState(nv)

        // crosshair is checked per component since it changes most frequently
        if (cur.crosshairPos && (!last.crosshairPos ||
          cur.crosshairPos[0] !== last.crosshairPos[0] ||
          cur.crosshairPos[1] !== last.crosshairPos[1] ||
          cur.crosshairPos[2] !== last.crosshairPos[2])) {
          last.crosshairPos = cur.crosshairPos
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
    channel.onopen = async () => {
      const hash = await hashVolume(nvRef)
      if (hash) { try { channel.send(JSON.stringify({ type: 'hash-check', hash })) } catch (e) {} }
      else { peer.verified = true; Boostlet.hint('peer connected', 2000) }
    }
    channel.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'hash-check') { handleHashCheck(peerId, msg.hash); return }
      if (!peer.verified) return

      // handle targeted diff messages directly
      if (msg.type === 'crosshair' || msg.type === 'sliceType' || msg.type === 'colormap' || msg.type === 'calRange') {
        applyingRemote = true
        applyDiff(nvRef, {
          crosshairPos: msg.crosshairPos,
          sliceType: msg.sliceType,
          colormap: msg.colormap,
          cal_min: msg.cal_min,
          cal_max: msg.cal_max
        })
        applyingRemote = false
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

    const row = el('div', 'display:flex;align-items:center;gap:8px')
    row.append(el('span', 'color:#4a4;letter-spacing:.1em;font-size:13px', code), copyBtn)
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
