;(function () {
  if (window.__boostlet_sync_injected) return
  window.__boostlet_sync_injected = true

  // ===== config =====

  const BOOSTLET_URL = 'https://boostlet.org/dist/boostlet.min.js'
  const PUSHER_KEY = '1a1ef7128331ff9bbc00'
  const PUSHER_CLUSTER = 'us2'
  const PUSHER_AUTH_URL = 'https://boostlet-pusher-auth.bronsdonayden.workers.dev'
  const CHUNK_SIZE = 65536
  const BUFFER_THRESHOLD = 1048576
  const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

  // register a dropbox app at https://www.dropbox.com/developers/apps
  // set the app key here and add the redirect url to your app settings
  // paths are relative to the app folder root since we use app folder access type
  const DROPBOX_APP_KEY = '4ugn042y7wktv7t'
  const DROPBOX_REDIRECT = 'https://bronsdonayden.github.io/boostlet/dropbox-callback.html'

  // ===== state =====

  const state = {
    nv: null,
    pusher: null,
    channel: null,
    peers: new Map(),
    selfId: null,
    myHash: null,
    applyingRemote: false,
    patchInterval: null,
    rafId: null,
    pollId: null,
    dropboxToken: null,
    roomCode: null
  }

  // ===== public api =====

  window.__sync_send = function (msg) { broadcast(msg) }
  window.__sync_send_volume = function () { sendVolumeToAll() }

  window.__boostlet_sync_destroy = function () {
    if (state.pollId) clearInterval(state.pollId)
    if (state.patchInterval) clearInterval(state.patchInterval)
    if (state.rafId) cancelAnimationFrame(state.rafId)
    if (state.channel) state.channel.unbind_all()
    if (state.pusher) state.pusher.disconnect()
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
        loadPusher(function () { start(nv) })
      } catch (e) {}
    }, 300)
  }

  // load pusher js sdk from cdn then call cb
  function loadPusher(cb) {
    if (window.Pusher) { cb(); return }
    const s = document.createElement('script')
    s.src = 'https://js.pusher.com/8.4.0/pusher.min.js'
    s.onload = cb
    document.head.appendChild(s)
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

  function makeCode() {
    return Math.random().toString(36).slice(2, 7)
  }

  async function hostScene() {
    const code = makeCode()
    state.roomCode = code

    const params = new URLSearchParams(location.search)
    params.set('sync', code)
    history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`)

    updatePanel(code)
    connectToRoom(code)

    // write initial scene snapshot to dropbox and store the public url in kv
    // keyed by room code so joiners can fetch it with just the code
    const sceneUrl = await writeSceneToDropbox(code, readScene(true))
    if (sceneUrl) {
      await fetch(`${PUSHER_AUTH_URL}/scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, sceneUrl })
      }).catch(() => {})
    }

    // patch dropbox scene snapshot every 3s with current display state
    state.patchInterval = setInterval(async () => {
      const s = readScene(false)
      s.activeBoostlets = (window.__boostlet_active || []).map(({ name, url }) => ({ name, url }))
      await writeSceneToDropbox(code, s)
    }, 3000)
  }

  async function joinScene(code) {
    state.roomCode = code
    let scene

    // look up the scene url from kv using the room code
    try {
      const res = await fetch(`${PUSHER_AUTH_URL}/scene/${code}`)
      if (res.ok) {
        const { sceneUrl } = await res.json()
        if (sceneUrl) scene = await readSceneFromDropbox(sceneUrl)
      }
    } catch (e) {}

    if (!scene) {
      // no scene found so just connect to the room and wait for host
      updatePanel(code)
      connectToRoom(code)
      return
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

  // ===== dropbox scene storage =====

  // scene snapshots live at /scenes/{code}.json relative to the app folder root
  // volumes live at /{filename} relative to the app folder root
  // joiners authenticate with their own dropbox account and fetch directly

  // upload scene json to dropbox and return a public direct download url
  // the url is embedded in the sync link so joiners can fetch it without auth
  async function writeSceneToDropbox(code, scene) {
    const token = await dropboxAuth()
    if (!token) return null

    // use a timestamped filename so each write gets a fresh file and a fresh link
    // avoids stale cached shared links from dropbox
    const path = `/scenes/${code}_${Date.now()}.json`
    const data = new TextEncoder().encode(JSON.stringify(scene))

    let fileId = null
    try {
      const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false }),
          'Content-Type': 'application/octet-stream'
        },
        body: data
      })
      if (!uploadRes.ok) return null
      const uploadData = await uploadRes.json()
      fileId = uploadData.id
    } catch (e) { return null }

    if (!fileId) return null

    // create or fetch existing shared link so the joiner can fetch without auth
    try {
      const linkRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fileId, settings: { requested_visibility: 'public', audience: 'public' } })
      })
      let linkData = null
      if (linkRes.status === 409) {
        const existingRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fileId, direct_only: true })
        })
        const existingData = await existingRes.json()
        linkData = existingData.links?.[0]
      } else if (linkRes.ok) {
        linkData = await linkRes.json()
      }
      if (!linkData?.url) return null
      // convert to direct download url
      // replace dl=0 with dl=1 if present otherwise append it as a param
      let directUrl = linkData.url.replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      if (directUrl.includes('dl=0')) {
        directUrl = directUrl.replace('dl=0', 'dl=1')
      } else {
        directUrl += (directUrl.includes('?') ? '&' : '?') + 'dl=1'
      }
      return directUrl
    } catch (e) { return null }
  }

  // fetch scene json from a public dropbox url — no auth needed
  async function readSceneFromDropbox(sceneUrl) {
    const res = await fetch(sceneUrl)
    if (!res.ok) throw new Error('scene not found')
    return res.json()
  }

  // ===== dropbox oauth =====

  function generateCodeVerifier() {
    const arr = new Uint8Array(32)
    crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
  }

  async function generateCodeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  async function dropboxAuth() {
    if (state.dropboxToken) return state.dropboxToken
    if (!DROPBOX_APP_KEY) {
      Boostlet.hint('no dropbox app key configured', 4000)
      return null
    }

    const verifier = generateCodeVerifier()
    const challenge = await generateCodeChallenge(verifier)

    const authUrl = 'https://www.dropbox.com/oauth2/authorize'
      + '?client_id=' + DROPBOX_APP_KEY
      + '&response_type=code'
      + '&code_challenge=' + challenge
      + '&code_challenge_method=S256'
      + '&redirect_uri=' + encodeURIComponent(DROPBOX_REDIRECT)
      + '&token_access_type=online'

    const popup = window.open(authUrl, 'dropbox_auth', 'width=500,height=700')
    if (!popup) { Boostlet.hint('popup blocked by browser', 4000); return null }

    const authCode = await new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.data?.type === 'dropbox-auth') {
          window.removeEventListener('message', onMsg)
          resolve(e.data.code)
        }
      }
      window.addEventListener('message', onMsg)
      const check = setInterval(() => {
        try { if (popup.closed) { clearInterval(check); window.removeEventListener('message', onMsg); resolve(null) } }
        catch (e) { clearInterval(check); window.removeEventListener('message', onMsg); resolve(null) }
      }, 500)
    })

    if (!authCode) { Boostlet.hint('dropbox auth cancelled', 3000); return null }

    try {
      const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: authCode,
          grant_type: 'authorization_code',
          code_verifier: verifier,
          client_id: DROPBOX_APP_KEY,
          redirect_uri: DROPBOX_REDIRECT
        })
      })
      const tokenData = await tokenRes.json()
      if (!tokenData.access_token) { Boostlet.hint('dropbox auth failed', 4000); return null }
      state.dropboxToken = tokenData.access_token
      return state.dropboxToken
    } catch (e) {
      Boostlet.hint('dropbox auth failed', 4000)
      return null
    }
  }

  // ===== dropbox volume upload =====

  async function uploadToDropbox(niftiData, filename) {
    const token = await dropboxAuth()
    if (!token) return null

    // path is relative to app folder root
    const path = '/' + filename

    let fileId = null
    try {
      const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false }),
          'Content-Type': 'application/octet-stream'
        },
        body: niftiData
      })
      if (!uploadRes.ok) { Boostlet.hint('dropbox upload failed', 4000); return null }
      // use the file id from upload response so sharing api works regardless of access type
      const uploadData = await uploadRes.json()
      fileId = uploadData.id
    } catch (e) { Boostlet.hint('dropbox upload failed', 4000); return null }

    if (!fileId) { Boostlet.hint('dropbox upload failed', 4000); return null }

    let linkData = null
    try {
      const linkRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fileId, settings: { requested_visibility: 'public', audience: 'public' } })
      })
      if (linkRes.status === 409) {
        const existingRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fileId, direct_only: true })
        })
        const existingData = await existingRes.json()
        linkData = existingData.links?.[0]
      } else if (linkRes.ok) {
        linkData = await linkRes.json()
      }
    } catch (e) { Boostlet.hint('could not create dropbox link', 4000); return null }

    if (!linkData?.url) { Boostlet.hint('could not create dropbox link', 4000); return null }

    let directUrl = linkData.url.replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    if (directUrl.includes('dl=0')) {
      directUrl = directUrl.replace('dl=0', 'dl=1')
    } else {
      directUrl += (directUrl.includes('?') ? '&' : '?') + 'dl=1'
    }
    return directUrl
  }

  async function uploadVolumeToDropbox() {
    const vol = state.nv.volumes?.[0]
    if (!vol?.img) { Boostlet.hint('no volume to upload', 3000); return }

    const nifti = buildNifti1({
      dims: Array.from(vol.hdr.dims),
      pixDims: Array.from(vol.hdr.pixDims),
      datatypeCode: vol.hdr.datatypeCode,
      numBitsPerVoxel: vol.hdr.numBitsPerVoxel,
      scl_slope: vol.hdr.scl_slope,
      scl_inter: vol.hdr.scl_inter,
      sform_code: vol.hdr.sform_code,
      qform_code: vol.hdr.qform_code,
      affine: vol.hdr.affine
    }, vol.img)

    Boostlet.hint('uploading to dropbox', 3000)
    const filename = 'volume_' + Date.now() + '.nii'
    const url = await uploadToDropbox(nifti, filename)
    if (!url) return

    // patch scene snapshot with volume url and update the sync link
    if (state.roomCode) {
      const scene = readScene(true)
      scene.volumeUrl = url
      const sceneUrl = await writeSceneToDropbox(state.roomCode, scene)
      if (sceneUrl) {
        await fetch(`${PUSHER_AUTH_URL}/scene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: state.roomCode, sceneUrl })
        }).catch(() => {})
      }
    }

    Boostlet.hint('volume uploaded to dropbox', 3000)
  }

  // ===== volume transfer (webrtc data channel) =====

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
    const bytes = new Uint8Array(hdrBuf)
    bytes[344] = 110; bytes[345] = 43; bytes[346] = 49; bytes[347] = 0
    const nifti = new Uint8Array(352 + voxelData.byteLength)
    nifti.set(bytes, 0)
    nifti.set(new Uint8Array(voxelData.buffer, voxelData.byteOffset, voxelData.byteLength), 352)
    return nifti
  }

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
    for (const chunk of transfer.chunks) { assembled.set(new Uint8Array(chunk), offset); offset += chunk.byteLength }

    const nv = state.nv
    const vol = nv.volumes?.[0]
    const meta = pendingMetas.get(transfer.transferId)
    if (meta) pendingMetas.delete(transfer.transferId)

    if (!meta && vol?.img && vol.img.byteLength === assembled.byteLength) {
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

  // ===== pusher signaling =====

  function connectToRoom(code) {
    // pusher presence channels give us room membership for free
    // client events (client-offer, client-answer, client-ice) carry webrtc signaling
    // no custom websocket server needed
    const pusher = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      authEndpoint: PUSHER_AUTH_URL,
      auth: {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    })

    state.pusher = pusher

    const channel = pusher.subscribe(`presence-boostlet-${code}`)
    state.channel = channel

    // fired once when our subscription succeeds
    // members.me.id is our pusher assigned socket id
    channel.bind('pusher:subscription_succeeded', (members) => {
      state.selfId = members.me.id

      // initiate offers to peers already in the room if our id is greater
      // tiebreaker ensures only one side offers to avoid double offer race
      members.each(member => {
        if (member.id !== state.selfId) {
          if (state.selfId > member.id) makeOffer(member.id)
          else getPeer(member.id, false)
        }
      })
    })

    channel.bind('pusher:subscription_error', () => {
      Boostlet.hint('could not join sync room', 4000)
    })

    // new peer joined so we send them an offer if our id is greater
    channel.bind('pusher:member_added', (member) => {
      if (state.selfId > member.id) makeOffer(member.id)
      else getPeer(member.id, false)
    })

    // peer left so clean up their rtc connection
    channel.bind('pusher:member_removed', (member) => {
      removePeer(member.id)
    })

    // webrtc signaling via pusher client events
    channel.bind('client-offer', (data) => {
      if (data.to !== state.selfId) return
      handleOffer(data.from, data.payload)
    })

    channel.bind('client-answer', (data) => {
      if (data.to !== state.selfId) return
      handleAnswer(data.from, data.payload)
    })

    channel.bind('client-ice', (data) => {
      if (data.to !== state.selfId) return
      handleIce(data.from, data.payload)
    })

    startBroadcasting()
  }

  function sendSignal(type, to, payload) {
    if (!state.channel) return
    // client- prefix is required for pusher client events
    state.channel.trigger(`client-${type}`, { from: state.selfId, to, payload })
  }

  // ===== webrtc =====

  function startBroadcasting() {
    let last = { crosshairPos: null, sliceType: null, colormap: null, cal_min: null, cal_max: null }
    let lastCrosshairBroadcast = 0

    const tick = () => {
      state.rafId = requestAnimationFrame(tick)
      const cur = readScene(false)

      if (state.applyingRemote) { last = cur; return }

      const now = Date.now()
      const patch = {}

      const crosshairChanged = cur.crosshairPos && (!last.crosshairPos ||
        cur.crosshairPos.some((v, i) => v !== last.crosshairPos[i]))
      if (crosshairChanged && now - lastCrosshairBroadcast >= 33) {
        patch.crosshairPos = cur.crosshairPos
        last.crosshairPos = cur.crosshairPos
        lastCrosshairBroadcast = now
      }
      if (cur.sliceType !== last.sliceType) { patch.sliceType = cur.sliceType; last.sliceType = cur.sliceType }
      if (cur.colormap !== last.colormap) { patch.colormap = cur.colormap; last.colormap = cur.colormap }
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
    // tiebreaker so only one side offers when both peers join simultaneously
    // the peer with the greater id always offers to avoid double offer race
    if (state.selfId < peerId) return
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
    const peer = { conn, channel: null, pendingCandidates: [], remoteDescSet: false, verified: false, isOfferer: createChannel }
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
      try { channel.send(JSON.stringify({ type: 'hash-hello', hash })) } catch (e) {}
      if (!hash) { peer.verified = true; Boostlet.hint('peer connected', 2000) }
    }

    channel.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) { receiveChunk(e.data); return }
      let msg; try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'hash-hello') { handleHashHello(peerId, msg.hash); return }
      if (msg.type === 'hash-result') {
        peer.verified = true
        Boostlet.hint(msg.match ? 'peer connected' : 'volume incoming from peer', msg.match ? 2000 : 3000)
        return
      }
      if (msg.type === 'volume-meta') { pendingMetas.set(msg.transferId, msg); return }
      if (!peer.verified) return

      if (msg.type === 'scene-patch') {
        state.applyingRemote = true
        applyDiff(msg.patch)
        setTimeout(() => { state.applyingRemote = false }, 0)
        return
      }
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
    const match = localHash === remoteHash || (!localHash && !remoteHash)
    peer.verified = true
    try { peer.channel.send(JSON.stringify({ type: 'hash-result', match })) } catch (e) {}
    if (!match && localHash && peer.isOfferer) {
      Boostlet.hint('sending volume to peer', 2000)
      sendVolumeToPeer(peer)
    } else {
      Boostlet.hint(match ? 'peer connected' : 'peer volume mismatch', match ? 2000 : 5000)
    }
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
    Boostlet.hint('peer disconnected', 2000)
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

    if (DROPBOX_APP_KEY) {
      const dropboxBtn = el('button', `${BTN_CSS};background:#0061fe;color:#fff;margin-top:2px`, 'save to dropbox')
      dropboxBtn.onclick = async () => {
        dropboxBtn.disabled = true
        dropboxBtn.textContent = 'uploading...'
        await uploadVolumeToDropbox()
        dropboxBtn.disabled = false
        dropboxBtn.textContent = 'save to dropbox'
      }
      row.append(dropboxBtn)
    }

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

})()
