function readID3(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return {};
  const ver = u8[3];
  const dv = new DataView(buf);
  const syncsafe = (i) => (u8[i] << 21) | (u8[i + 1] << 14) | (u8[i + 2] << 7) | u8[i + 3];
  const end = Math.min(u8.length, 10 + syncsafe(6));
  let p = 10;
  if (u8[5] & 0x40) p += ver === 4 ? syncsafe(10) : dv.getUint32(10) + 4;

  const decode = (enc, bytes) => {
    let label = "iso-8859-1";
    if (enc === 3) label = "utf-8";
    else if (enc === 2) label = "utf-16be";
    else if (enc === 1) label = bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-16le";
    return new TextDecoder(label).decode(bytes).replace(/^﻿/, "").split("\0")[0].trim();
  };
  const strEnd = (bytes, i, enc) => {
    if (enc === 1 || enc === 2) {
      while (i + 1 < bytes.length && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2;
      return i + 2;
    }
    while (i < bytes.length && bytes[i] !== 0) i++;
    return i + 1;
  };

  const out = {};
  while (p + 10 <= end) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = ver === 4 ? syncsafe(p + 4) : dv.getUint32(p + 4);
    const body = u8.subarray(p + 10, Math.min(end, p + 10 + size));
    p += 10 + size;
    if (!body.length) continue;
    const enc = body[0];
    if (id === "TIT2") out.title = decode(enc, body.subarray(1));
    else if (id === "TPE1") out.artist = decode(enc, body.subarray(1));
    else if (id === "APIC" && !out.picture) {
      let i = 1;
      while (i < body.length && body[i] !== 0) i++;
      const mime = new TextDecoder("iso-8859-1").decode(body.subarray(1, i)) || "image/jpeg";
      i += 2;
      i = strEnd(body, i, enc);
      out.picture = new Blob([body.slice(i)], { type: mime.includes("/") ? mime : "image/" + mime.toLowerCase() });
    }
  }
  return out;
}
