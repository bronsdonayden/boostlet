;(function () {
  if (window.__onnx_demo_active) return
  window.__onnx_demo_active = true

  const BOOSTLET_URL = 'https://boostlet.org/dist/boostlet.min.js'
  const ORT_VERSION = '1.20.1'
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/'
  const FALLBACK_SIZE = 256

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.onload = resolve
      s.onerror = () => reject(new Error('failed to load ' + src))
      document.head.appendChild(s)
    })
  }

  async function start() {
    if (!window.Boostlet) await loadScript(BOOSTLET_URL)
    Boostlet.init()
    console.log('Boostlet initialized', Boostlet.framework?.name)
    if (!window.ort) {
      await loadScript(ORT_BASE + 'ort.min.js')
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = {
        'ort-wasm-simd-threaded.wasm': ORT_BASE + 'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd.wasm': ORT_BASE + 'ort-wasm-simd.wasm',
        'ort-wasm.wasm': ORT_BASE + 'ort-wasm.wasm',
      }
    }
    showDropzone()
  }

  function showDropzone() {
    const nv = Boostlet.framework.instance
    if (!nv?.volumes?.length) return Boostlet.hint('no volume loaded', 3000)

    const box = document.createElement('div')
    box.style.cssText = [
      'position:fixed;top:20px;right:20px;z-index:999999',
      'background:#111;color:#ddd;border:2px dashed #666',
      'padding:16px;font:12px monospace;cursor:pointer'
    ].join(';')
    box.textContent = 'drop .onnx here'
    document.body.appendChild(box)
    box.ondragover = e => e.preventDefault()
    box.ondrop = e => { e.preventDefault(); runDemo(nv, e.dataTransfer.files[0], box) }
    box.onclick = () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.onnx'
      input.onchange = () => runDemo(nv, input.files[0], box)
      input.click()
    }
  }

  function inspectModel(session) {
    if (session.inputNames.length !== 1) throw new Error('demo supports one input')
    if (session.outputNames.length !== 1) throw new Error('demo supports one output')

    const name = session.inputNames[0]
    const meta = Array.isArray(session.inputMetadata)
      ? session.inputMetadata[0]
      : session.inputMetadata?.[name]
    const shape = meta?.shape || meta?.dimensions || meta?.dims || []
    if (shape.length !== 4) throw new Error('expected 4D input, got ' + JSON.stringify(shape))

    const channels = Number(shape[1]) || 1
    const height = Number(shape[2]) || FALLBACK_SIZE
    const width = Number(shape[3]) || FALLBACK_SIZE
    if (channels !== 1 && channels !== 3) throw new Error('expected 1 or 3 channels, got ' + channels)

    return { inputName: name, outputName: session.outputNames[0], channels, height, width }
  }

  function volumeRange(vol) {
    if (Number.isFinite(vol.cal_min) && Number.isFinite(vol.cal_max) && vol.cal_max > vol.cal_min) {
      return [vol.cal_min, vol.cal_max]
    }
    let lo = Infinity
    let hi = -Infinity
    for (const v of vol.img) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return [lo, hi > lo ? hi : lo + 1]
  }

  function makeInputSlice(vol, z, cfg, range) {
    const d = vol.hdr.dims
    const X = d[1]
    const Y = d[2]
    const slope = vol.hdr.scl_slope || 1
    const inter = vol.hdr.scl_inter || 0
    const [lo, hi] = range
    const gray = new Float32Array(cfg.width * cfg.height)

    for (let y = 0; y < cfg.height; y++) {
      const sy = Math.min(Y - 1, Math.floor(y * Y / cfg.height))
      for (let x = 0; x < cfg.width; x++) {
        const sx = Math.min(X - 1, Math.floor(x * X / cfg.width))
        const raw = vol.img[sx + sy * X + z * X * Y]
        gray[x + y * cfg.width] = Math.max(0, Math.min(1, (raw * slope + inter - lo) / (hi - lo)))
      }
    }
    if (cfg.channels === 1) return gray

    const input = new Float32Array(3 * gray.length)
    input.set(gray, 0)
    input.set(gray, gray.length)
    input.set(gray, gray.length * 2)
    return input
  }

  function decodeOutput(tensor, cfg) {
    const data = tensor.data
    const pixels = cfg.width * cfg.height
    const mask = new Uint8Array(pixels)
    if (data.length === pixels) {
      for (let i = 0; i < pixels; i++) mask[i] = data[i] > 0.5 ? 1 : 0
      return mask
    }

    const dims = tensor.dims || []
    const channels = dims.length === 4 ? dims[1] : Math.floor(data.length / pixels)
    if (channels <= 1 || data.length < channels * pixels) {
      throw new Error('unsupported output shape: ' + JSON.stringify(dims))
    }
    for (let i = 0; i < pixels; i++) {
      let best = 0
      let bestVal = data[i]
      for (let c = 1; c < channels; c++) {
        const val = data[c * pixels + i]
        if (val > bestVal) { bestVal = val; best = c }
      }
      mask[i] = best ? 1 : 0
    }
    return mask
  }

  function pasteMaskSlice(dst, src, z, X, Y, cfg) {
    for (let y = 0; y < Y; y++) {
      const sy = Math.min(cfg.height - 1, Math.floor(y * cfg.height / Y))
      for (let x = 0; x < X; x++) {
        const sx = Math.min(cfg.width - 1, Math.floor(x * cfg.width / X))
        dst[x + y * X + z * X * Y] = src[sx + sy * cfg.width]
      }
    }
  }

  async function addOverlay(nv, baseVol, mask) {
    const overlay = await baseVol.clone()
    overlay.zeroImage()
    overlay.img = mask
    overlay.hdr.scl_slope = 1
    overlay.hdr.scl_inter = 0
    overlay.hdr.intent_code = 1002
    overlay.colormap = 'red'
    overlay.opacity = 0.5
    await nv.addVolume(overlay)
    nv.drawScene?.()
  }

  async function runDemo(nv, file, el) {
    if (!file) return
    try {
      el.style.color = '#ddd'
      el.textContent = 'loading model...'
      const session = await ort.InferenceSession.create(await file.arrayBuffer())
      const cfg = inspectModel(session)
      const vol = nv.volumes[0]
      const d = vol.hdr.dims
      const X = d[1], Y = d[2], Z = d[3]
      const maskVol = new Uint8Array(X * Y * Z)
      const range = volumeRange(vol)
      el.textContent = `model ${cfg.channels}x${cfg.height}x${cfg.width}`

      for (let z = 0; z < Z; z++) {
        const input = makeInputSlice(vol, z, cfg, range)
        const feeds = { [cfg.inputName]: new ort.Tensor('float32', input, [1, cfg.channels, cfg.height, cfg.width]) }
        const result = await session.run(feeds)
        pasteMaskSlice(maskVol, decodeOutput(result[cfg.outputName], cfg), z, X, Y, cfg)
        if (z % 5 === 0) {
          el.textContent = `slice ${z + 1} / ${Z}`
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }

      el.textContent = 'adding overlay...'
      await addOverlay(nv, vol, maskVol)
      el.textContent = 'done'
      el.style.color = '#5f5'
    } catch (err) {
      el.textContent = 'error: ' + (err?.message || err)
      el.style.color = '#f66'
      console.error('ONNX demo failed:', err)
    }
  }

  start().catch(console.error)
})()
