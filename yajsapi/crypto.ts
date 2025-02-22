import * as crypto from "crypto";
import * as eccrypto from "eccrypto";
import * as secp256k1 from "secp256k1";

export function rand_hex(length: number): string {
  const byte_sz = Math.floor(length / 2);
  return crypto.randomBytes(byte_sz).toString("hex");
}

export class PrivateKey {
  inner!: Buffer;

  constructor() {
    this.inner = eccrypto.generatePrivate();
  }

  static from(buffer: Buffer): PrivateKey {
    const key = Object.create(this.prototype);
    key.inner = buffer;
    return key;
  }

  static fromHex(hex: string): PublicKey {
    const inner = Buffer.from(hex, "hex");
    return PublicKey.from(inner);
  }

  publicKey(compressed = true): PublicKey {
    const buffer = compressed ? eccrypto.getPublicCompressed(this.inner) : eccrypto.getPublic(this.inner);
    return PublicKey.from(buffer);
  }

  async derive(publicKey: PublicKey): Promise<Buffer> {
    return await eccrypto.derive(this.inner, publicKey.inner);
  }

  async sign(msg: Buffer) {
    return await eccrypto.sign(this.inner, msg);
  }

  toString(): string {
    return this.inner.toString("hex");
  }
}

export class PublicKey {
  inner!: Buffer;

  static from(buffer: Buffer): PublicKey {
    const key = Object.create(this.prototype);
    key.inner = buffer;
    return key;
  }

  static fromHex(hex: string): PublicKey {
    const inner = Buffer.from(hex, "hex");
    return PublicKey.from(inner);
  }

  toString(): string {
    return this.inner.toString("hex");
  }
}

export class CryptoCtx {
  priv_key!: PrivateKey;
  ephem_key!: Buffer;

  static async from(pub_key: PublicKey, priv_key?: PrivateKey): Promise<CryptoCtx> {
    priv_key = priv_key ? priv_key : new PrivateKey();
    const ephem_key = Buffer.from(secp256k1.ecdh(pub_key.inner, priv_key.inner));
    return new CryptoCtx(priv_key, ephem_key);
  }

  private constructor(priv_key: PrivateKey, ephem_key: Buffer) {
    this.priv_key = priv_key;
    this.ephem_key = ephem_key;
  }

  encrypt(data: Buffer): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.ephem_key, iv);

    const chunk_1 = cipher.update(data);
    const chunk_2 = cipher.final();
    const tag = cipher.getAuthTag();

    const buffer = Buffer.alloc(1 + iv.length + 1 + tag.length, 0, "binary");
    let off = 0;

    buffer.writeUInt8(iv.length, off);
    off += 1;
    iv.copy(buffer, off);
    off += iv.length;
    buffer.writeUInt8(tag.length, off);
    off += 1;
    tag.copy(buffer, off);

    return Buffer.concat([buffer, chunk_1, chunk_2]);
  }

  decrypt(data: Buffer): Buffer {
    let off = 0;
    const iv_length = data.readUInt8(off);
    off += 1;
    const iv = data.slice(off, off + iv_length);
    off += iv_length;
    const tag_length = data.readUInt8(off);
    off += 1;
    const tag = data.slice(off, off + tag_length);
    off += tag_length;
    const enc = data.slice(off);

    const cipher = crypto.createDecipheriv("aes-256-gcm", this.ephem_key, iv);
    cipher.setAuthTag(tag);

    return Buffer.concat([cipher.update(enc), cipher.final()]);
  }
}
