// stats.js — numpy-ts powered statistics for Boostlet
// Lazy-loads numpy-ts once on first call, then reuses the instance.
//
// Usage from a boostlet:
//   const stats = await Boostlet.stats();
//   const result = stats.all(data, nv.volumes[0]);

const NUMPY_TS_URL = 'https://esm.run/numpy-ts';

let _np = null;

// only load numpy-ts once, cache it in _np
async function _load() {
  if (!_np) {
    _np = await import(NUMPY_TS_URL);
  }
  return _np;
}

export async function loadStats() {
  const np = await _load();

  return {

    // convert typed array to a numpy-ts array so we can run ops on it
    _wrap(data) {
      return np.array(Array.from(data), 'float32');
    },

    // apply nifti slope/intercept: display = raw * slope + inter
    _applyScaling(data, volume) {
      if (!volume) return this._wrap(data);
      const slope = volume.hdr.scl_slope || 1;
      const inter = volume.hdr.scl_inter || 0;
      const a = this._wrap(data);
      return a.multiply(slope).add(inter);
    },

    // numpy-ts returns array objects not plain numbers, unwrap to a scalar
    _scalar(val) {
      return typeof val === 'number' ? val : val.tolist ? val.tolist() : Number(val);
    },

    mean(data, volume) {
      return this._scalar(np.mean(this._applyScaling(data, volume)));
    },

    std(data, volume) {
      return this._scalar(np.std(this._applyScaling(data, volume)));
    },

    min(data, volume) {
      return this._scalar(np.min(this._applyScaling(data, volume)));
    },

    max(data, volume) {
      return this._scalar(np.max(this._applyScaling(data, volume)));
    },

    percentile(data, p, volume) {
      return this._scalar(np.percentile(this._applyScaling(data, volume), p));
    },

    // returns all stats in one pass
    // pass volume as second arg to apply slope/intercept
    all(data, volume) {
      const a = this._applyScaling(data, volume);
      return {
        mean : this._scalar(np.mean(a)),
        std  : this._scalar(np.std(a)),
        min  : this._scalar(np.min(a)),
        max  : this._scalar(np.max(a)),
        p25  : this._scalar(np.percentile(a, 25)),
        p75  : this._scalar(np.percentile(a, 75)),
      };
    }

  };
}
