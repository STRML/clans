export interface MissionObject {
  class: string;
  name: string | null;
  props: Record<string, string>;
  children: MissionObject[];
}

type TokenKind = 'string' | 'word' | 'delimiter';

interface Token {
  value: string;
  line: number;
  /** string: quoted literal. word: bare identifier or keyword. delimiter: one of { } ( ) ; = */
  kind: TokenKind;
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
      tokens.push({ value: char, line, kind: 'delimiter' });
      index += 1;
      continue;
    }
    if (char === '"') {
      const result = readString(source, index, line);
      tokens.push({ value: result.value, line: result.line, kind: 'string' });
      index = result.nextIndex;
      line = result.nextLine;
      continue;
    }
    const result = readWord(source, index, line);
    tokens.push({ value: result.value, line: result.line, kind: 'word' });
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

  /** Consumes a bare word: a class name, object name, or property key. */
  takeIdentifier(role: string): Token {
    const token = this.take();
    if (token.kind !== 'word' || token.value === 'new') {
      throw new SyntaxError(
        `Expected ${role}, got ${describe(token)} at line ${String(token.line)}`,
      );
    }
    return token;
  }

  /** Consumes the next token. With `value`, it must be that exact bare keyword or delimiter. */
  take(value?: string): Token {
    const token = this.tokens[this.index];
    if (!token || (value !== undefined && (token.value !== value || token.kind === 'string'))) {
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

const isDelimiter = (token: Token | undefined, value: string): boolean =>
  token !== undefined && token.kind === 'delimiter' && token.value === value;

const describe = (token: Token): string =>
  token.kind === 'string' ? 'quoted string' : `${token.kind} ${token.value}`;

function parseHeader(cursor: Cursor): { classToken: Token; name: string | null } {
  cursor.take('new');
  const classToken = cursor.takeIdentifier('class name');
  cursor.take('(');
  const next = cursor.peek();
  const name = isDelimiter(next, ')') ? null : cursor.takeIdentifier('object name').value;
  cursor.take(')');
  cursor.take('{');
  return { classToken, name };
}

/** A property value is exactly one token followed by a semicolon. Mission files always quote values. */
function parsePropertyValue(cursor: Cursor, classToken: Token): string {
  assertNotEof(cursor, classToken);
  const token = cursor.take();
  if (token.kind === 'delimiter' || (token.kind === 'word' && token.value === 'new')) {
    throw new SyntaxError(`Expected a value, got ${describe(token)} at line ${String(token.line)}`);
  }
  assertNotEof(cursor, classToken);
  cursor.take(';');
  return token.value;
}

function parseBody(cursor: Cursor, classToken: Token, object: MissionObject): void {
  while (cursor.peek() && !isDelimiter(cursor.peek(), '}')) {
    const next = cursor.peek();
    if (next && next.kind === 'word' && next.value === 'new') {
      object.children.push(parseObject(cursor));
      continue;
    }
    const key = cursor.takeIdentifier('property key').value;
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
