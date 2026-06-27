(function() {

const CATEGORY = "Statistics";

const script = document.createElement("script");
script.type = "text/javascript";
script.src = "http://localhost:5501/dist/boostlet.min.js";
script.onload = run;
document.head.appendChild(script);

const HALF = 4;

async function run() {
  Boostlet.init();

  if (Boostlet.framework.name !== 'niivue') {
    alert('Only niivue is supported right now :(');
    return;
  }

  const nv = Boostlet.framework.instance;

  if (!nv.volumes || !nv.volumes.length) {
    const wait = setInterval(function() {
      if (nv.volumes && nv.volumes.length > 0) {
        clearInterval(wait);
        setup(nv);
      }
    }, 300);
    return;
  }

  setup(nv);
}

async function setup(nv) {
  plot();

  const stats = await Boostlet.stats();

  const existingOnLocationChange = nv.onLocationChange;

  nv.onLocationChange = async function(loc) {
    if (existingOnLocationChange) existingOnLocationChange(loc);
    if (!nv.volumes || !nv.volumes.length) return;

    const v = [Math.round(loc.vox[0]), Math.round(loc.vox[1]), Math.round(loc.vox[2])];

    const start = [v[0] - HALF, v[1] - HALF, v[2] - HALF];
    const end   = [v[0] + HALF, v[1] + HALF, v[2] + HALF];

    const fixedAxis = nv.opts.sliceType === nv.sliceTypeSagittal ? 0
                    : nv.opts.sliceType === nv.sliceTypeCoronal  ? 1 : 2;
    start[fixedAxis] = end[fixedAxis] = Math.round((start[fixedAxis] + end[fixedAxis]) / 2);

    const { data } = Boostlet.get_subvolume(start, end);
    if (!data || data.length === 0) return;

    const result = stats.all(data, nv.volumes[0]);
    updatePanel(result);
  };
}

function updatePanel(s) {
  document.getElementById('roi-mean').textContent = s.mean.toFixed(2);
  document.getElementById('roi-std').textContent  = s.std.toFixed(2);
  document.getElementById('roi-min').textContent  = s.min.toFixed(2);
  document.getElementById('roi-max').textContent  = s.max.toFixed(2);
  document.getElementById('roi-p25').textContent  = s.p25.toFixed(2);
  document.getElementById('roi-p75').textContent  = s.p75.toFixed(2);
}

function plot() {
  const existing = document.getElementById('RoiStatsDiv');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'RoiStatsDiv';
  div.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 1000;
    background: rgba(0,0,0,0.85); color: #fff;
    font-family: monospace; font-size: 13px;
    padding: 12px 16px; border-radius: 6px;
    border: 1px solid #444; min-width: 160px;
    cursor: move; line-height: 2;
  `;

  div.innerHTML = `
    <div style="font-size:11px;color:#aaa;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.08em;">ROI Stats (${HALF*2+1}×${HALF*2+1})</div>
    <div>mean <span id="roi-mean" style="float:right;color:#7cf">—</span></div>
    <div>std  <span id="roi-std"  style="float:right;color:#7cf">—</span></div>
    <div>min  <span id="roi-min"  style="float:right;color:#7cf">—</span></div>
    <div>max  <span id="roi-max"  style="float:right;color:#7cf">—</span></div>
    <div>p25  <span id="roi-p25"  style="float:right;color:#7cf">—</span></div>
    <div>p75  <span id="roi-p75"  style="float:right;color:#7cf">—</span></div>
  `;

  document.body.appendChild(div);

  let startX, startY, startRight, startTop;
  div.addEventListener('mousedown', function(e) {
    startX     = e.clientX;
    startY     = e.clientY;
    startRight = div.offsetLeft;
    startTop   = div.offsetTop;
    function onMove(e) {
      div.style.left  = (startRight + e.clientX - startX) + 'px';
      div.style.top   = (startTop  + e.clientY - startY) + 'px';
      div.style.right = 'auto';
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
