export interface Cursor {
  view: DataView;
  offset: number;
}

export function createWriter(byteLength: number): Cursor {
  return { view: new DataView(new ArrayBuffer(byteLength)), offset: 0 };
}
export function createReader(bytes: Uint8Array): Cursor {
  return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
}

export function writeU8(cursor: Cursor, value: number): void {
  cursor.view.setUint8(cursor.offset, value);
  cursor.offset += 1;
}
export function readU8(cursor: Cursor): number {
  const value = cursor.view.getUint8(cursor.offset);
  cursor.offset += 1;
  return value;
}
export function writeU16(cursor: Cursor, value: number): void {
  cursor.view.setUint16(cursor.offset, value, true);
  cursor.offset += 2;
}
export function readU16(cursor: Cursor): number {
  const value = cursor.view.getUint16(cursor.offset, true);
  cursor.offset += 2;
  return value;
}
export function writeI16(cursor: Cursor, value: number): void {
  cursor.view.setInt16(cursor.offset, value, true);
  cursor.offset += 2;
}
export function readI16(cursor: Cursor): number {
  const value = cursor.view.getInt16(cursor.offset, true);
  cursor.offset += 2;
  return value;
}
export function writeU32(cursor: Cursor, value: number): void {
  cursor.view.setUint32(cursor.offset, value, true);
  cursor.offset += 4;
}
export function readU32(cursor: Cursor): number {
  const value = cursor.view.getUint32(cursor.offset, true);
  cursor.offset += 4;
  return value;
}
export function writeF32(cursor: Cursor, value: number): void {
  cursor.view.setFloat32(cursor.offset, value, true);
  cursor.offset += 4;
}
export function readF32(cursor: Cursor): number {
  const value = cursor.view.getFloat32(cursor.offset, true);
  cursor.offset += 4;
  return value;
}
export function bytesOf(cursor: Cursor): Uint8Array {
  return new Uint8Array(cursor.view.buffer, cursor.view.byteOffset, cursor.offset);
}
