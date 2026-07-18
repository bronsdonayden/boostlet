const CATEGORY = "Utility";

// re-injection guard so clicking the bookmarklet twice doesnt break anything
if (typeof window._NumpyBoostletLoaded === 'undefined') {
window._NumpyBoostletLoaded = true;

(function() {

const NUMPY_TS_URL = 'https://cdn.jsdelivr.net/npm/numpy-ts@1.3.0/dist/numpy-ts.browser.js';
const ACE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.33.0/ace.js';

// load boostlet first then poll until niivue is detected
const boostletScript = document.createElement('script');
boostletScript.type = 'text/javascript';
boostletScript.src = 'http://localhost:5501/dist/boostlet.min.js';
boostletScript.onload = function() {
  var poll = setInterval(function() {
    try {
      Boostlet.init();
      clearInterval(poll);
      setup();
    } catch(e) {}
  }, 300);
};
document.head.appendChild(boostletScript);

async function setup() {
  if (Boostlet.framework.name !== 'niivue') {
    alert('numpyBoostlet only supports niivue');
    return;
  }

  // load numpyts and make it a global var
  window.np = await import(NUMPY_TS_URL);

  // returns a flat float32 numpy array of  voxel values
  // no slope or intercept applied
  window.to_numpy = function() {
    const img = Boostlet.framework.instance.volumes[0].img;
    return np.array(Array.from(img), 'float32');
  };

  // writes a typed array / numpyts array back into vol.img and renders
  // if the array is like a numpyts object tjen pull the data via arr.data
  window.update_from_numpy = function(arr) {
    const nv = Boostlet.framework.instance;
    const vol = nv.volumes[0];
    const src = (arr && arr.data) ? arr.data : arr;
    vol.img.set(src);
    nv.updateGLVolume();
  };

  // load ace which is the text editor thing then build the editor panel
  const aceScript = document.createElement('script');
  aceScript.src = ACE_URL;
  aceScript.onload = function() { plot(); };
  document.head.appendChild(aceScript);
}

// snapshot of vol.img saved before each run so undo can restore it
window._numpySnapshot = null;

function runCode() {
  const outputDiv = document.getElementById('nb-output');
  const vol = Boostlet.framework.instance.volumes[0];

  // save current state before running
  window._numpySnapshot = vol.img.slice();
  outputDiv.innerHTML = '';

  // redirect console.log to the output div for this run
  const origLog = console.log;
  console.log = function(msg) { outputDiv.innerHTML += msg + '<br>'; };

  // wrap in async so user code can await if needed
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  new AsyncFunction(window._numpyEditor.getValue())().then(() => {
    console.log = origLog;
  }).catch(err => {
    outputDiv.innerHTML += '<span style="color:#f77">' + err.toString() + '</span>';
    console.log = origLog;
  });
}

function undoCode() {
  if (!window._numpySnapshot) return;
  const nv = Boostlet.framework.instance;
  nv.volumes[0].img.set(window._numpySnapshot);
  nv.updateGLVolume();
  window._numpySnapshot = null;
  document.getElementById('nb-output').innerHTML = '<span style="color:#aaa">undo applied</span>';
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    #nb-panel {
      position: fixed; top: 40px; left: 40px; z-index: 2147483647;
      width: 600px; height: 500px; min-width: 300px; min-height: 200px; font-family: monospace;
      background: #1a1a1a; border: 1px solid #444; border-radius: 6px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
      resize: both; overflow: hidden;
      display: flex; flex-direction: column;
    }
    #nb-titlebar {
      padding: 8px 12px; background: #111;
      border-radius: 6px 6px 0 0; border-bottom: 1px solid #333;
      display: flex; align-items: center; justify-content: space-between;
      user-select: none; cursor: move;
    }
    #nb-titlebar span { color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    #nb-titlebar span em { color: #555; font-style: normal; }
    #nb-close { color: #666; cursor: pointer; font-size: 16px; }
    #nb-editor-div { width: 100%; flex: 1; min-height: 100px; overflow: hidden; }
    #nb-toolbar {
      padding: 6px 10px; background: #111; border-top: 1px solid #333;
      display: flex; align-items: center; gap: 8px;
    }
    #nb-toolbar span { color: #555; font-size: 11px; }
    #nb-run-btn, #nb-undo-btn {
      border: none; border-radius: 4px;
      padding: 5px 16px; font-family: monospace; font-size: 13px; cursor: pointer;
    }
    #nb-run-btn { background: #2a6; color: #fff; }
    #nb-undo-btn { background: #333; color: #aaa; border: 1px solid #555; }
    #nb-output {
      padding: 8px 12px; min-height: 32px; max-height: 120px; overflow-y: auto;
      color: #7cf; font-size: 12px; border-top: 1px solid #333;
      background: #0d0d0d; border-radius: 0 0 6px 6px;
    }
  `;
  document.head.appendChild(style);
}

function plot() {
  const existing = document.getElementById('nb-panel');
  if (existing) existing.remove();

  injectStyles();

  const div = document.createElement('div');
  div.id = 'nb-panel';
  div.innerHTML = `
    <div id="nb-titlebar">
      <span>numpy boostlet &nbsp;<em>np &bull; to_numpy() &bull; update_from_numpy(arr)</em></span>
      <span id="nb-close">&#x2715;</span>
    </div>
    <div id="nb-editor-div"></div>
    <div id="nb-toolbar">
      <button id="nb-run-btn">run</button>
      <button id="nb-undo-btn">undo</button>
      <span>ctrl+enter</span>
    </div>
    <div id="nb-output"></div>
  `;
  document.body.appendChild(div);

  const editor = ace.edit('nb-editor-div');
  editor.setTheme('ace/theme/monokai');
  editor.session.setMode('ace/mode/javascript');
  editor.setFontSize(13);
  editor.setOption('wrap', true);
  editor.setValue(
`// vol.img is raw int16 so all thresholds must be in raw space
// display = raw * slope + inter
// raw = (display - inter) / slope

const vol = Boostlet.framework.instance.volumes[0];
const slope = vol.hdr.scl_slope;
const inter = vol.hdr.scl_inter;

const display_threshold = 500;
const raw_threshold = (display_threshold - inter) / slope;
const raw_zero = Math.round((0 - inter) / slope);

const copy = vol.img.slice();
for (let i = 0; i < copy.length; i++) {
  if (copy[i] < raw_threshold) copy[i] = raw_zero;
}
update_from_numpy(copy);`,
    -1
  );
  window._numpyEditor = editor;

  // keep ace redrawn when the panel is resized
  new ResizeObserver(() => editor.resize()).observe(document.getElementById('nb-editor-div'));

  editor.commands.addCommand({
    name: 'run',
    bindKey: { win: 'Ctrl-Enter', mac: 'Cmd-Enter' },
    exec: runCode
  });

  document.getElementById('nb-run-btn').addEventListener('click', runCode);
  document.getElementById('nb-undo-btn').addEventListener('click', undoCode);
  document.getElementById('nb-close').addEventListener('click', () => div.remove());

  // drag is bound to the titlebar only so the editor stays interactive
  const titlebar = document.getElementById('nb-titlebar');
  titlebar.addEventListener('mousedown', function(e) {
    if (e.target.id === 'nb-close') return;
    const startX = e.clientX, startY = e.clientY;
    const startLeft = div.offsetLeft, startTop = div.offsetTop;
    function onMove(e) {
      div.style.left = (startLeft + e.clientX - startX) + 'px';
      div.style.top  = (startTop  + e.clientY - startY) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

})();
}
