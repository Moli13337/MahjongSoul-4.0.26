/**
 * liqi protocol loader and encoder/decoder.
 *
 * Wire format (5 layers):
 *   [type byte][msg_id u16 LE?][Wrapper protobuf]
 *                               └─ name + data(bytes)
 *                                         └─ inner DynamicMessage
 *                                            └─ {name, data: base64(XOR(protobuf))}  // action only
 *
 * Type byte: 01=Notify, 02=Request, 03=Response.
 * Request/Response carry a little-endian u16 message id at offset 1..3.
 * Notify has no msg_id.
 */

import * as protobuf from 'protobufjs';
import * as path from 'path';
import { xorCodec } from '../crypto/xor';

export enum MessageType {
  NOTIFY = 1,
  REQUEST = 2,
  RESPONSE = 3,
}

export interface LiqiMessage {
  msgType: MessageType;
  msgId?: number;
  methodName: string;
  payload: any;
}

// Wrapper message: { string name = 1; bytes data = 2; }
interface Wrapper {
  name: string;
  data: Buffer;
}

let root: protobuf.Root | null = null;
let liqiJson: any = null;

/** Load the protobuf definition and liqi.json routing table */
export async function initProto(): Promise<void> {
  // __dirname when compiled is dist/proto, so go up 2 levels to project root, then into src/proto
  const projectRoot = path.resolve(__dirname, '..', '..');
  const protoPath = path.resolve(projectRoot, 'src', 'proto', 'liqi.proto');
  root = await protobuf.load(protoPath);

  const jsonPath = path.resolve(projectRoot, 'src', 'proto', 'liqi.json');
  liqiJson = require(jsonPath);

  console.log('[proto] Loaded liqi.proto and liqi.json');
}

/** Get a message type by full name (e.g. "lq.Wrapper") */
function lookupType(name: string): protobuf.Type | null {
  if (!root) throw new Error('Proto not initialized');
  return root.lookupType(name) || null;
}

/** Get request/response type names from liqi.json for a 3-part method name */
function lookupMethodTypes(methodName: string): { reqType: string; respType: string } | null {
  if (!liqiJson) throw new Error('liqi.json not loaded');

  // methodName is like ".lq.Lobby.oauth2Login"
  const parts = methodName.split('.').filter(s => s.length > 0);
  if (parts.length !== 3) return null;

  try {
    // liqi.json structure: { nested: { lq: { nested: { Route: { methods: { requestConnection: { requestType, responseType } } }, Lobby: { methods: { ... } }, ... } } } } }
    const entry = liqiJson.nested[parts[0]].nested[parts[1]].methods[parts[2]];
    return {
      reqType: parts[0] + '.' + entry.requestType,
      respType: parts[0] + '.' + entry.responseType,
    };
  } catch {
    return null;
  }
}

/** Get the notify message type name for a 2-part name (e.g. ".lq.NotifyRoomGameStart") */
function lookupNotifyType(name: string): string | null {
  const parts = name.split('.').filter(s => s.length > 0);
  if (parts.length !== 2) return null;
  return parts[0] + '.' + parts[1];
}

/** Encode a Wrapper protobuf message */
function encodeWrapper(name: string, data: Buffer): Buffer {
  // Wrapper: field 1 = string name, field 2 = bytes data
  const parts: Buffer[] = [];

  if (name.length > 0) {
    // field 1, wire type 2 (length-delimited)
    const nameBuf = Buffer.from(name, 'utf8');
    parts.push(encodeVarint((1 << 3) | 2));
    parts.push(encodeVarint(nameBuf.length));
    parts.push(nameBuf);
  }

  if (data.length > 0) {
    // field 2, wire type 2 (length-delimited)
    parts.push(encodeVarint((2 << 3) | 2));
    parts.push(encodeVarint(data.length));
    parts.push(data);
  }

  return Buffer.concat(parts);
}

/** Decode a Wrapper protobuf message */
function decodeWrapper(buf: Buffer): Wrapper {
  let offset = 0;
  let name = '';
  let data = Buffer.alloc(0);

  while (offset < buf.length) {
    const tag = decodeVarint(buf, offset);
    offset += tag.bytesRead;
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 0x7;

    if (wireType === 2) {
      // length-delimited
      const len = decodeVarint(buf, offset);
      offset += len.bytesRead;
      const content = buf.slice(offset, offset + len.value);
      offset += len.value;

      if (fieldNum === 1) {
        name = content.toString('utf8');
      } else if (fieldNum === 2) {
        data = content;
      }
    } else if (wireType === 0) {
      // varint - skip
      const v = decodeVarint(buf, offset);
      offset += v.bytesRead;
    } else {
      break; // unknown wire type, stop
    }
  }

  return { name, data };
}

/** Encode a varint */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

/** Decode a varint */
function decodeVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const b = buf[offset + bytesRead];
    value |= (b & 0x7f) << shift;
    bytesRead++;
    if (!(b & 0x80)) break;
    shift += 7;
  }

  return { value, bytesRead };
}

/** Encode a protobuf message by type name */
export function encodeMessage(typeName: string, payload: any): Buffer {
  const type = lookupType(typeName);
  if (!type) {
    throw new Error(`Unknown message type: ${typeName}`);
  }
  const err = type.verify(payload);
  if (err) {
    console.warn(`[proto] Verify warning for ${typeName}: ${err}`);
    // Don't throw - protobufjs create() will silently drop invalid fields
    // but still encode valid ones, which is better than dropping the entire message
  }
  const msg = type.create(payload);
  return Buffer.from(type.encode(msg).finish());
}

/** Decode a protobuf message by type name */
export function decodeMessage(typeName: string, data: Buffer): any {
  const type = lookupType(typeName);
  if (!type) {
    throw new Error(`Unknown message type: ${typeName}`);
  }
  const msg = type.decode(data);
  return type.toObject(msg, {
    defaults: true,
    longs: Number,
    bytes: String,
    oneofs: true,
  });
}

/** Per-connection session that holds state for request/response correlation */
export class LiqiSession {
  private pending = new Map<number, { methodName: string; respType: string }>();
  private nextMsgId = 1;

  /** Parse a raw WebSocket binary frame into a LiqiMessage */
  parseFrame(buf: Buffer): LiqiMessage {
    if (buf.length === 0) throw new Error('Empty frame');

    const msgType = buf[0] as MessageType;

    switch (msgType) {
      case MessageType.NOTIFY: {
        const wrapper = decodeWrapper(buf.slice(1));
        const typeName = lookupNotifyType(wrapper.name);
        let payload: any = {};
        if (typeName) {
          try {
            payload = decodeMessage(typeName, wrapper.data);
          } catch (e) {
            console.warn(`[proto] Failed to decode notify ${wrapper.name}:`, e);
          }
        }
        return { msgType, methodName: wrapper.name, payload };
      }

      case MessageType.REQUEST: {
        if (buf.length < 3) throw new Error('Request frame too short');
        const msgId = buf.readUInt16LE(1);
        const wrapper = decodeWrapper(buf.slice(3));
        const types = lookupMethodTypes(wrapper.name);
        let payload: any = {};

        if (types) {
          this.pending.set(msgId, { methodName: wrapper.name, respType: types.respType });
          try {
            payload = decodeMessage(types.reqType, wrapper.data);
          } catch (e) {
            console.warn(`[proto] Failed to decode request ${wrapper.name}:`, e);
          }
        }

        return { msgType, msgId, methodName: wrapper.name, payload };
      }

      case MessageType.RESPONSE: {
        if (buf.length < 3) throw new Error('Response frame too short');
        const msgId = buf.readUInt16LE(1);
        const wrapper = decodeWrapper(buf.slice(3));
        const pending = this.pending.get(msgId);

        let methodName = '';
        let payload: any = {};

        if (pending) {
          methodName = pending.methodName;
          this.pending.delete(msgId);
          try {
            payload = decodeMessage(pending.respType, wrapper.data);
          } catch (e) {
            console.warn(`[proto] Failed to decode response for ${pending.methodName}:`, e);
          }
        }

        return { msgType, msgId, methodName, payload };
      }

      default:
        throw new Error(`Invalid liqi message type byte: ${msgType}`);
    }
  }

  /** Allocate the next message id for outgoing requests */
  allocMsgId(): number {
    return this.nextMsgId++;
  }
}

/** Build a Notify frame */
export function buildNotify(methodName: string, typeName: string, payload: any): Buffer {
  const data = encodeMessage(typeName, payload);
  const wrapper = encodeWrapper(methodName, data);
  return Buffer.concat([Buffer.from([MessageType.NOTIFY]), wrapper]);
}

/** Build a Request frame (caller provides msgId, e.g. from session.allocMsgId()) */
export function buildRequest(methodName: string, reqType: string, payload: any, msgId: number): { frame: Buffer; msgId: number } {
  const data = encodeMessage(reqType, payload);
  const wrapper = encodeWrapper(methodName, data);
  const msgIdBuf = Buffer.alloc(2);
  msgIdBuf.writeUInt16LE(msgId, 0);
  const frame = Buffer.concat([Buffer.from([MessageType.REQUEST]), msgIdBuf, wrapper]);
  return { frame, msgId };
}

/** Build a Response frame */
export function buildResponse(msgId: number, respType: string, payload: any): Buffer {
  const data = encodeMessage(respType, payload);
  const wrapper = encodeWrapper('', data); // Response has empty name
  const msgIdBuf = Buffer.alloc(2);
  msgIdBuf.writeUInt16LE(msgId, 0);
  return Buffer.concat([Buffer.from([MessageType.RESPONSE]), msgIdBuf, wrapper]);
}

/** Build an ActionPrototype Notify with XOR-encrypted action data */
export function buildActionNotify(actionName: string, actionPayload: any, step: number): Buffer {
  // Encode the action message
  const actionTypeName = `lq.${actionName}`;
  const actionData = encodeMessage(actionTypeName, actionPayload);

  // XOR encrypt
  const encrypted = xorCodec(actionData);

  // Base64 encode
  const b64 = encrypted.toString('base64');

  // Build the inner {name, data} wrapper
  const innerPayload = { name: actionName, data: b64 };
  const innerData = encodeMessage('lq.ActionPrototype', { ...innerPayload, step });

  // Wrap as Notify
  const wrapper = encodeWrapper('.lq.ActionPrototype', innerData);
  return Buffer.concat([Buffer.from([MessageType.NOTIFY]), wrapper]);
}
