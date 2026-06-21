CATEGORY = "Visualization"

const script = document.createElement("script");
script.type = "text/javascript";
script.src = "https://boostlet.org/dist/boostlet.min.js";

script.onload = run;
document.head.appendChild(script);

const HALF = 4;

function run() {
  Boostlet.init();

  if (Boostlet.framework.name !== 'niivue') {
    alert('Only niivue is supported right now :(');
    return;
  }

  const nv = Boostlet.framework.instance;

  if (!nv.volumes.length) {
    alert('No volume loaded yet!');
    return;
  }

  // Create the panel once
  plot();

  // Save the existing onLocationChange so we don't clobber it
  const existingOnLocationChange = nv.onLocationChange;

  // Hook into location change — fires on every crosshair move / slice change
  nv.onLocationChange = function(loc) {
    // call the original if it existed
    if (existingOnLocationChange) existingOnLocationChange(loc);

    if (!nv.volumes.length) return;

    const v = [Math.round(loc.vox[0]), Math.round(loc.vox[1]), Math.round(loc.vox[2])]; // Cursor position in voxel coordinates.

    const start = [v[0] - HALF, v[1] - HALF, v[2] - HALF];
    const end   = [v[0] + HALF, v[1] + HALF, v[2] + HALF];

    // collapses the slice plane axis to a single voxel
    // axial(0) Z=2, coronal(1) Y=1, sagittal(2) X=0 so that you don't get a 3D chunk of data
    const fixedAxis = nv.opts.sliceType === nv.sliceTypeSagittal ? 0
                    : nv.opts.sliceType === nv.sliceTypeCoronal  ? 1 : 2;
    start[fixedAxis] = end[fixedAxis] = Math.round((start[fixedAxis] + end[fixedAxis]) / 2); // Flattens axis, finds midpoint

    const { data, dims } = Boostlet.get_subvolume(start, end);
    if (data && dims) {
      const mc = document.getElementById('PixelExplorerCanvas');
      if (mc) drawMatrix(data, dims, mc);
    }
  };
}

// render voxel values as a labeled grayscale grid
function drawMatrix(data, dims, mc) {
  const nv = Boostlet.framework.instance;
  const { cal_min, cal_max } = nv.volumes[0];
  const range = cal_max - cal_min || 1; // range between display values.
  const ctx = mc.getContext('2d');

  // apply nifti slope/intercept to convert raw values to display values.
  // raw voxel values can be stored in arbitrary units (e.g. large negatives like -9000)
  // and need to be scaled to match what NiiVue actually displays: display_value = raw * slope + inter
  const slope = nv.volumes[0].hdr.scl_slope || 1;
  const inter = nv.volumes[0].hdr.scl_inter || 0;

  // getVolumeData returns dims as X Y Z and the collapsed axis has size 1
  // the first non 1 dim is cols second is rows
  const [cols, rows] = dims.filter(d => d > 1);
  if (!cols || !rows) return;

  const cell = Math.floor(Math.min(mc.width / cols, mc.height / rows)); // picks between max cell width and max cell height. picks the smallest
  if (cell < 1) return;

  // Figures out whether to show a label or not. needs to be changed IMO
  const showLabels = cell >= 8;
  if (showLabels) {
    ctx.font = `${Math.max(Math.floor(cell * 0.28), 6)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  ctx.clearRect(0, 0, mc.width, mc.height);

  // Loops through every voxel in the region, draws a grey square for each one based on how bright it is. If the cells are
  // big enough, it prints out raw number on top.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const raw = data[c + (rows - 1 - r) * cols];
      const val = raw * slope + inter; // convert raw to display value
      const norm = (val - cal_min) / range; // Gives a range from 0 - 1, gets normalized to 0-255 in the line below
      const g = Math.round(norm * 255);

      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(c * cell, r * cell, cell, cell);

      if (showLabels) {
        ctx.fillStyle = norm > 0.55 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)';
        ctx.fillText(val.toFixed(0), c * cell + cell / 2, r * cell + cell / 2);
      }
    }
  }
}

function plot() {
  // Remove existing panel if re ran
  const existing = document.getElementById('PixelExplorerDiv');
  if (existing) existing.remove();

  let container = window.document.createElement('div');
  container.id = 'PixelExplorerDiv';
  container.style.cssText = 'position:fixed; top:10px; left:10px; z-index:1000; cursor:move;';
  window.document.body.appendChild(container);

  const mc = document.createElement('canvas');
  mc.id = 'PixelExplorerCanvas';
  mc.width = 400;
  mc.height = 400;
  mc.style.cssText = 'display:block; width:400px; height:400px;';
  container.appendChild(mc);

  // Drag logic
  let startX, startY, startLeft, startTop;
  container.addEventListener('mousedown', function(e) {
    startX = e.clientX;
    startY = e.clientY;
    startLeft = container.offsetLeft;
    startTop = container.offsetTop;

    function onMove(e) {
      container.style.left = (startLeft + e.clientX - startX) + 'px';
      container.style.top  = (startTop  + e.clientY - startY) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}