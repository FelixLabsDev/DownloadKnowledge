let lastTs = 0;
let seq = 0;

/**
 * UUIDv7: 48-bit millisecond timestamp, a 12-bit counter, then random bits.
 * Ids made by one device sort in creation order, even within a millisecond.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now > lastTs) {
    lastTs = now;
    seq = 0;
  } else if (++seq > 0xfff) {
    lastTs++;
    seq = 0;
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ts = lastTs;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
