// Where each person sits in the animation. No physics: a position depends
// only on the login, its parent and its depth, so the same search always
// draws the same picture, in whatever order the answers arrive.
//
// Each side is a set of rings around its own origin (the source at 25% of the
// width, the target at 75%). Depth d sits on ring d, so each side looks like a
// wave spreading outward, and the two waves overlap in the middle. The rings
// are ellipses so that three of them fit the height of a wide canvas.

export const JITTER = 0.15; // how far off its ring a node may sit, in rings
const FIRST_SLOT = (2 * Math.PI) / 12; // angular room each depth-1 node gets for its children
const SLOT_SHRINK = 0.6;

// FNV-1a, mapped to [0, 1). `salt` gives independent values for one login.
export function hash(str, salt = 0) {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

export function createLayout(width = 800, height = 450) {
  const polar = new Map(); // "side:login" -> { angle, slot, r }
  let w, h, gapX, gapY, origins;

  function resize(newW, newH) {
    w = newW;
    h = newH;
    origins = { source: { x: w * 0.25, y: h / 2 }, target: { x: w * 0.75, y: h / 2 } };
    gapX = w * 0.16; // ring 2 reaches past the middle, so the waves overlap
    gapY = Math.max(4, (h / 2 - 16) / (3 + JITTER)); // ring 3 fits the height
  }
  resize(width, height);

  // Adds a node (once) from a `discover` event. Its parent must be placed first.
  function place({ side, login, parent, depth }) {
    const key = `${side}:${login}`;
    if (polar.has(key)) return polar.get(key);
    let p;
    if (depth === 0) {
      p = { angle: 0, slot: 2 * Math.PI, r: 0 };
    } else {
      const r = depth + (hash(login, 7) - 0.5) * 2 * JITTER;
      const from = polar.get(`${side}:${parent}`);
      if (depth === 1 || !from) {
        p = { angle: 2 * Math.PI * hash(login), slot: FIRST_SLOT, r };
      } else {
        p = { angle: from.angle + (hash(login) - 0.5) * from.slot, slot: from.slot * SLOT_SHRINK, r };
      }
    }
    polar.set(key, p);
    return p;
  }

  function pos(side, login) {
    const p = polar.get(`${side}:${login}`);
    if (!p) return null;
    const o = origins[side];
    return { x: o.x + Math.cos(p.angle) * p.r * gapX, y: o.y + Math.sin(p.angle) * p.r * gapY };
  }

  // The ellipse for ring r (fractional allowed) around a side's origin.
  const ring = (side, r) => ({ ...origins[side], rx: r * gapX, ry: r * gapY });

  return {
    place,
    pos,
    ring,
    resize,
    polarOf: (side, login) => polar.get(`${side}:${login}`),
    origin: (side) => origins[side],
    clear: () => polar.clear(),
  };
}
