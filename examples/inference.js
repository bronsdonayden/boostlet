;(function () {
  if (window.__inference_active) return
  window.__inference_active = true

  const BOOSTLET_URL = 'https://boostlet.org/dist/boostlet.min.js'
  const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/'
  const SIZE = 256
  const CHANNELS = 3

  function loadScript(url, cb) {
    const s = document.createElement('script')
    s.src = url; s.onload = cb; s.onerror = () => console.error('failed to load', url)
    document.head.appendChild(s)
  }

  function start() {
    if (!window.Boostlet) { loadScript(BOOSTLET_URL, start); return }
    Boostlet.init()
    if (!window.ort) {
      loadScript(ORT_CDN + 'ort.min.js', () => {
        console.log('ort loaded', ort.env.versions)
        ort.env.wasm.numThreads = 1
        ort.env.wasm.simd = false
        ort.env.wasm.wasmPaths = ORT_CDN
        showUI()
      })
      return
    }
    showUI()
  }

  function showUI() {
    const nv = Boostlet.framework.instance
    if (!nv?.volumes?.length) { Boostlet.hint('no volume loaded', 3000); return }
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;background:#111;border:2px dashed #555;padding:20px;font:12px monospace;color:#aaa;cursor:pointer'
    box.textContent = 'drop .onnx here'
    document.body.appendChild(box)
    box.ondragover = e => e.preventDefault()
    box.ondrop = e => { e.preventDefault(); go(nv, e.dataTransfer.files[0], box) }
    box.onclick = () => { const f = document.createElement('input'); f.type='file'; f.accept='.onnx'; f.onchange = () => go(nv, f.files[0], box); f.click() }
  }

  async function go(nv, file, el) {
    if (!file) return
    el.textContent = 'loading model...'
    console.log('loading model', file.name, file.size, 'bytes')
    try {
      const buf = await file.arrayBuffer()
      console.log('arraybuffer ready', buf.byteLength)
      const session = await ort.InferenceSession.create(buf)
      console.log('session created', session.inputNames, session.outputNames)

      const vol = nv.volumes[0], d = vol.hdr.dims
      const X = d[1], Y = d[2], Z = d[3]
      console.log('volume dims', X, Y, Z)
      const sl = vol.hdr.scl_slope || 1, si = vol.hdr.scl_inter || 0
      const lo = vol.cal_min, rng = (vol.cal_max - lo) || 1
      const mask = new Uint8Array(X * Y * Z)

      for (let z = 0; z < Z; z++) {
        const gray = new Float32Array(SIZE * SIZE)
        for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
          const v = vol.img[Math.round(i * X / SIZE) + Math.round(j * Y / SIZE) * X + z * X * Y]
          gray[j * SIZE + i] = Math.max(0, Math.min(1, (v * sl + si - lo) / rng))
        }
        const inp = new Float32Array(CHANNELS * SIZE * SIZE)
        for (let c = 0; c < CHANNELS; c++) inp.set(gray, c * SIZE * SIZE)

        const out = (await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', inp, [1, CHANNELS, SIZE, SIZE]) }))[session.outputNames[0]].data
        const px = SIZE * SIZE

        for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) {
          const idx = Math.round(j * SIZE / Y) * SIZE + Math.round(i * SIZE / X)
          let val = out[idx]
          if (val < 0 || val > 1) val = 1 / (1 + Math.exp(-val))
          mask[i + j * X + z * X * Y] = val > 0.5 ? 1 : 0
        }
        if (z % 10 === 0) { el.textContent = z + '/' + Z; await new Promise(r => setTimeout(r, 0)) }
      }

      const h = new DataView(new ArrayBuffer(352))
      h.setInt32(0, 348, true)
      h.setInt16(40, 3, true); h.setInt16(42, X, true); h.setInt16(44, Y, true); h.setInt16(46, Z, true)
      h.setInt16(70, 2, true); h.setInt16(72, 8, true)
      for (let i = 0; i < 8; i++) h.setFloat32(76 + i * 4, vol.hdr.pixDims[i] || 1, true)
      h.setFloat32(108, 352, true); h.setFloat32(112, 1, true)
      h.setInt16(252, vol.hdr.qform_code || 1, true); h.setInt16(254, vol.hdr.sform_code || 1, true)
      if (vol.hdr.affine) { let k = 0; for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) h.setFloat32(280 + (k++) * 4, vol.hdr.affine[r][c] || 0, true) }
      const hb = new Uint8Array(h.buffer); hb[344] = 110; hb[345] = 43; hb[346] = 49; hb[347] = 0
      const nii = new Uint8Array(352 + mask.length); nii.set(hb); nii.set(mask, 352)
      const url = URL.createObjectURL(new Blob([nii]))
      await nv.addVolumeFromUrl({ url, colormap: 'red', opacity: 0.5 })
      URL.revokeObjectURL(url); nv.drawScene?.()
      el.textContent = 'done'; el.style.color = '#4a4'
    } catch (e) {
      el.textContent = 'error'; el.style.color = '#f44'
      console.error('inference failed', e)
      console.error('stack', e?.stack || 'no stack')
    }
  }

  start()
})()
