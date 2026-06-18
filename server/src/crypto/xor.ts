/**
 * XOR encryption/decryption for Majsoul action payloads.
 *
 * Position-dependent XOR scheme used by Majsoul for action data.
 * The same function is used for both encoding and decoding (XOR is symmetric).
 */

const KEYS: number[] = [0x84, 0x5e, 0x4e, 0x42, 0x39, 0xa2, 0x1f, 0x60, 0x1c];

export function xorCodec(data: Buffer): Buffer {
  const base = 23 ^ data.length;
  const result = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    const k = KEYS[i % KEYS.length];
    result[i] = data[i] ^ ((base + 5 * i + k) & 0xff);
  }
  return result;
}
