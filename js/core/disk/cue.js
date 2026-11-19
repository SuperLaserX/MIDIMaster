// CUE sheet parser for .bin/.cue CD images. FILE paths in cue sheets are usually
// absolute paths from the machine that ripped the disc, so files are matched by name.

export function parseCue(text) {
  const files = [];
  let file = null;
  let track = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^FILE\s+(?:"([^"]*)"|(\S+))\s*(\S*)/i.exec(line);
    if (m) {
      file = { path: m[1] ?? m[2], type: (m[3] || 'BINARY').toUpperCase(), tracks: [] };
      files.push(file);
      track = null;
      continue;
    }
    m = /^TRACK\s+(\d+)\s+(\S+)/i.exec(line);
    if (m && file) {
      track = { number: Number(m[1]), mode: m[2].toUpperCase(), indexes: {} };
      file.tracks.push(track);
      continue;
    }
    m = /^INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)/i.exec(line);
    if (m && track) track.indexes[Number(m[1])] = (Number(m[2]) * 60 + Number(m[3])) * 75 + Number(m[4]);
  }
  return { files };
}

/** Sector size and data offset of a track mode, or null for audio tracks. */
export function trackLayout(mode) {
  switch (String(mode).toUpperCase()) {
    case 'MODE1/2048': return { sectorSize: 2048, dataOffset: 0 };
    case 'MODE1/2352': return { sectorSize: 2352, dataOffset: 16 };
    case 'MODE2/2336': return { sectorSize: 2336, dataOffset: 8 };
    case 'MODE2/2352': return { sectorSize: 2352, dataOffset: 24 };
    case 'MODE2/2048': return { sectorSize: 2048, dataOffset: 0 };
    default: return null;
  }
}

/** File name without directories, for either slash style. */
export function baseName(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * The first data track of a cue sheet: {fileName, sectorSize, dataOffset, start}.
 * start is the byte offset of the track inside its .bin file.
 */
export function firstDataTrack(cue) {
  for (const f of cue.files) {
    let sectorSize = 2352;
    for (const t of f.tracks) {
      const layout = trackLayout(t.mode);
      if (!layout) { sectorSize = 2352; continue; }
      const frames = t.indexes[1] ?? t.indexes[0] ?? 0;
      return { fileName: baseName(f.path), ...layout, start: frames * (layout.sectorSize || sectorSize) };
    }
  }
  return null;
}
