import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'

// A software WebAuthn authenticator for the acceptance suite: an ES256 key, "none"
// attestation, user verification always on. It produces what a browser's navigator.credentials
// would, so the server's real verification runs against it.

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url')
const sha256 = (b: Uint8Array | Buffer | string) => createHash('sha256').update(b).digest()

// Just enough CBOR: unsigned and negative ints, byte strings, text strings, maps.
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    return Buffer.from([(major << 5) | 25, n >> 8, n & 255])
  }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]) }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { const b = Buffer.from(v); return Buffer.concat([head(2, b.length), b]) }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])])
  throw new Error('cbor: unsupported value')
}

export class VirtualAuthenticator {
  readonly credentialId = randomBytes(16)
  private privateKey: KeyObject
  private x: Buffer
  private y: Buffer
  counter = 0

  constructor(private origin: string, private rpId: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    this.x = Buffer.from(jwk.x, 'base64url')
    this.y = Buffer.from(jwk.y, 'base64url')
  }

  get id() { return b64u(this.credentialId) }

  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  // The reply to navigator.credentials.create(options).
  register(options: { challenge: string }, over: { origin?: string } = {}) {
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]))
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credentialId.length)
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x45]), counter, Buffer.alloc(16), idLen, this.credentialId, cose])
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge, over.origin)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    }
  }

  // The reply to navigator.credentials.get(options). `flags` 0x05 = user present + verified.
  assert(options: { challenge: string }, over: { origin?: string; flags?: number; tamper?: boolean } = {}) {
    this.counter += 1
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([over.flags ?? 0x05]), counter])
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, over.origin)
    const sig = createSign('sha256').update(Buffer.concat([authData, sha256(clientDataJSON)])).sign(this.privateKey)
    if (over.tamper) sig[sig.length - 1] ^= 0xff
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: null },
    }
  }
}
