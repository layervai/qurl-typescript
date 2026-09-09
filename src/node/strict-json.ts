const MAX_JSON_DEPTH = 32;
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

export type StrictJsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

/**
 * Parse a bounded JSON value without JavaScript's duplicate-key or unsafe-
 * integer ambiguity. NHP uses uint64 session identifiers, so integral values
 * outside Number's safe range remain bigint instead of losing wire bytes.
 */
export function parseStrictJson(
  input: Uint8Array,
  maxBytes: number,
  onMember?: (object: object, key: string, raw: string) => void,
): StrictJsonValue {
  if (input.byteLength > maxBytes) throw new Error(`JSON exceeds ${maxBytes}-byte limit`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  const parser = new StrictJsonParser(text, onMember);
  const value = parser.parseValue(0);
  parser.skipWhitespace();
  if (!parser.done) throw new Error("trailing data after JSON value");
  return value;
}

class StrictJsonParser {
  #offset = 0;

  constructor(
    private readonly input: string,
    private readonly onMember?: (object: object, key: string, raw: string) => void,
  ) {}

  get done(): boolean {
    return this.#offset === this.input.length;
  }

  skipWhitespace(): void {
    while (this.#offset < this.input.length) {
      const code = this.input.charCodeAt(this.#offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      this.#offset++;
    }
  }

  parseValue(depth: number): StrictJsonValue {
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON nesting is too deep");
    this.skipWhitespace();
    const token = this.input[this.#offset];
    if (token === '"') return this.parseString();
    if (token === "{") return this.parseObject(depth + 1);
    if (token === "[") return this.parseArray(depth + 1);
    if (token === "t") return this.parseLiteral("true", true);
    if (token === "f") return this.parseLiteral("false", false);
    if (token === "n") return this.parseLiteral("null", null);
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) {
      return this.parseNumber();
    }
    throw new Error("invalid JSON value");
  }

  private parseObject(depth: number): { [key: string]: StrictJsonValue } {
    this.#offset++;
    const value: { [key: string]: StrictJsonValue } = Object.create(null) as {
      [key: string]: StrictJsonValue;
    };
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume("}")) return value;
    while (true) {
      this.skipWhitespace();
      if (this.input[this.#offset] !== '"') throw new Error("JSON object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) throw new Error("duplicate JSON object key");
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) throw new Error("JSON object key has no value");
      this.skipWhitespace();
      const start = this.#offset;
      value[key] = this.parseValue(depth);
      this.onMember?.(value, key, this.input.slice(start, this.#offset));
      this.skipWhitespace();
      if (this.consume("}")) return value;
      if (!this.consume(",")) throw new Error("invalid JSON object separator");
    }
  }

  private parseArray(depth: number): StrictJsonValue[] {
    this.#offset++;
    const value: StrictJsonValue[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return value;
    while (true) {
      value.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consume("]")) return value;
      if (!this.consume(",")) throw new Error("invalid JSON array separator");
    }
  }

  private parseString(): string {
    const start = this.#offset++;
    while (this.#offset < this.input.length) {
      const code = this.input.charCodeAt(this.#offset++);
      if (code === 0x22) {
        const encoded = this.input.slice(start, this.#offset);
        const value: unknown = JSON.parse(encoded);
        if (typeof value !== "string") throw new Error("invalid JSON string");
        return value;
      }
      if (code < 0x20) throw new Error("unescaped control in JSON string");
      if (code === 0x5c) {
        if (this.#offset >= this.input.length) throw new Error("unterminated JSON escape");
        if (this.input[this.#offset] === "u") {
          const hex = this.input.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("invalid JSON unicode escape");
          this.#offset += 5;
        } else {
          if (!'"\\/bfnrt'.includes(this.input[this.#offset])) {
            throw new Error("invalid JSON escape");
          }
          this.#offset++;
        }
      }
    }
    throw new Error("unterminated JSON string");
  }

  private parseNumber(): number | bigint {
    // A sticky expression scans at the current offset without copying the
    // remaining document for every number in a large deployment file.
    JSON_NUMBER.lastIndex = this.#offset;
    const match = JSON_NUMBER.exec(this.input);
    if (!match) throw new Error("invalid JSON number");
    const encoded = match[0];
    this.#offset = JSON_NUMBER.lastIndex;
    // Keep every syntactic JSON integer distinct from fractional or exponent
    // notation. NHP integer fields reject 1.0 and 1e0 even when Number would
    // reduce them to the same mathematical value as 1.
    if (!encoded.includes(".") && !/[eE]/.test(encoded)) {
      // BigInt("-0") becomes 0n and loses the wire sign. Keep negative zero as
      // a number so unsigned integer fields reject this noncanonical syntax.
      if (encoded === "-0") return -0;
      return BigInt(encoded);
    }
    const value = Number(encoded);
    if (!Number.isFinite(value)) throw new Error("JSON number is outside the finite range");
    return value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.input.startsWith(literal, this.#offset)) throw new Error("invalid JSON literal");
    this.#offset += literal.length;
    return value;
  }

  private consume(value: string): boolean {
    if (this.input[this.#offset] !== value) return false;
    this.#offset++;
    return true;
  }
}

export function isStrictJsonObject(
  value: StrictJsonValue | undefined,
): value is { [key: string]: StrictJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
