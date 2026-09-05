export interface MissionObject {
  class: string;
  name: string | null;
  props: Record<string, string>;
  children: MissionObject[];
}

interface Token {
  value: string;
  line: number;
  /** True for a quoted string literal, which is never a keyword or delimiter. */
  quoted: boolean;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function skipLineComment(source: string, index: number): number {
  let i = index;
  while (i < source.length && source[i] !== '\n') i += 1;
  return i;
}

interface ScanResult {
  value: string;
  line: number;
  nextIndex: number;
  nextLine: number;
}

function readString(source: string, index: number, line: number): ScanResult {
  const startLine = line;
  let i = index + 1;
  let currentLine = line;
  let value = '';
  while (i < source.length && source[i] !== '"') {
    const next = source[i] ?? '';
    if (next === '\\' && i + 1 < source.length) {
      value += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (next === '\n') currentLine += 1;
    value += next;
    i += 1;
  }
  if (source[i] !== '"') throw new SyntaxError(`Unterminated string at line ${startLine}`);
  return { value, line: startLine, nextIndex: i + 1, nextLine: currentLine };
}

function readWord(source: string, index: number, line: number): ScanResult {
  const start = index;
  let i = index;
  while (i < source.length && !/[\s{}();="]/.test(source[i] ?? '')) i += 1;
  return { value: source.slice(start, i), line, nextIndex: i, nextLine: line };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (isWhitespace(char)) {
      if (char === '\n') line += 1;
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if ('{}();='.includes(char)) {
      tokens.push({ value: char, line, quoted: false });
      index += 1;
      continue;
    }
    if (char === '"') {
      const result = readString(source, index, line);
      tokens.push({ value: result.value, line: result.line, quoted: true });
      index = result.nextIndex;
      line = result.nextLine;
      continue;
    }
    const result = readWord(source, index, line);
    tokens.push({ value: result.value, line: result.line, quoted: false });
    index = result.nextIndex;
  }
  return tokens;
}

class Cursor {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly totalLines: number,
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.index];
  }

  take(value?: string): Token {
    const token = this.tokens[this.index];
    if (!token || (value !== undefined && token.value !== value)) {
      throw new SyntaxError(
        `Expected ${value ?? 'token'} at line ${token?.line ?? this.totalLines}`,
      );
    }
    this.index += 1;
    return token;
  }
}

function assertNotEof(cursor: Cursor, classToken: Token): void {
  if (!cursor.peek()) {
    throw new SyntaxError(`Unterminated ${classToken.value} opened at line ${classToken.line}`);
  }
}

function parseHeader(cursor: Cursor): { classToken: Token; name: string | null } {
  cursor.take('new');
  const classToken = cursor.take();
  cursor.take('(');
  const name = cursor.peek()?.value === ')' ? null : cursor.take().value;
  cursor.take(')');
  cursor.take('{');
  return { classToken, name };
}

function parsePropertyValue(cursor: Cursor, classToken: Token): string {
  const parts: string[] = [];
  while (cursor.peek() && cursor.peek()?.value !== ';') {
    const token = cursor.take();
    if (!token.quoted && (token.value === 'new' || token.value === '}')) {
      throw new SyntaxError(`Expected ; before ${token.value} at line ${String(token.line)}`);
    }
    parts.push(token.value);
  }
  assertNotEof(cursor, classToken);
  cursor.take(';');
  return parts.join(' ');
}

function parseBody(cursor: Cursor, classToken: Token, object: MissionObject): void {
  while (cursor.peek() && cursor.peek()?.value !== '}') {
    const next = cursor.peek();
    if (next && !next.quoted && next.value === 'new') {
      object.children.push(parseObject(cursor));
      continue;
    }
    const key = cursor.take().value;
    cursor.take('=');
    object.props[key] = parsePropertyValue(cursor, classToken);
  }
  assertNotEof(cursor, classToken);
}

function parseObject(cursor: Cursor): MissionObject {
  const { classToken, name } = parseHeader(cursor);
  const object: MissionObject = { class: classToken.value, name, props: {}, children: [] };
  parseBody(cursor, classToken, object);
  cursor.take('}');
  cursor.take(';');
  return object;
}

export function parseMission(source: string): MissionObject[] {
  const tokens = tokenize(source);
  const cursor = new Cursor(tokens, source.split(/\r?\n/).length);
  const objects: MissionObject[] = [];
  while (cursor.peek()) objects.push(parseObject(cursor));
  return objects;
}
