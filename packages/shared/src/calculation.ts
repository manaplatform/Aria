type Token =
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'paren'; value: '(' | ')' }
  | { kind: 'comma' };

const constants: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const functions: Record<string, (...args: number[]) => number> = {
  abs: (x) => Math.abs(x),
  sqrt: (x) => {
    if (x < 0) throw new Error('Square root requires a non-negative input.');
    return Math.sqrt(x);
  },
  round: (x, digits = 0) => {
    const factor = 10 ** Math.trunc(digits);
    return Math.round(x * factor) / factor;
  },
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  sum: (...xs) => xs.reduce((total, item) => total + item, 0),
  avg: (...xs) => xs.reduce((total, item) => total + item, 0) / xs.length,
  pow: (x, y) => x ** y,
  log: (x) => {
    if (x <= 0) throw new Error('Logarithm requires a positive input.');
    return Math.log10(x);
  },
  ln: (x) => {
    if (x <= 0) throw new Error('Natural logarithm requires a positive input.');
    return Math.log(x);
  },
  exp: (x) => Math.exp(x),
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
};

function tokenize(raw: string): Token[] {
  const normalized = raw.replace(/\b(\d+(?:\.\d+)?)\s*%\s*of\b/gi, '($1 * 0.01) *');
  const tokens: Token[] = [];
  let index = 0;
  while (index < normalized.length) {
    const ch = normalized[index];
    if (/\s/.test(ch)) {
      index++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ kind: 'paren', value: ch });
      index++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      index++;
      continue;
    }
    if (normalized.startsWith('**', index)) {
      tokens.push({ kind: 'op', value: '^' });
      index += 2;
      continue;
    }
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      index++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^(?:\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?/.exec(
        normalized.slice(index),
      );
      if (!match)
        throw new Error(`Invalid numeric literal near "${normalized.slice(index, index + 12)}".`);
      const value = Number(match[0].replaceAll('_', ''));
      if (!Number.isFinite(value)) throw new Error('Numeric literal is out of range.');
      index += match[0].length;
      if (normalized[index] === '%' && !/[0-9.(]/.test(normalized[index + 1] ?? '')) {
        tokens.push({ kind: 'number', value: value * 0.01 });
        index++;
      } else {
        tokens.push({ kind: 'number', value });
      }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(normalized.slice(index))!;
      tokens.push({ kind: 'ident', value: match[0].toLowerCase() });
      index += match[0].length;
      continue;
    }
    throw new Error(`Unsupported character "${ch}" in expression.`);
  }
  if (!tokens.length || tokens.length > 256)
    throw new Error('Provide a bounded non-empty mathematical expression.');
  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const result = this.expression();
    if (this.position < this.tokens.length)
      throw new Error('Unexpected trailing tokens in expression.');
    if (!Number.isFinite(result)) throw new Error('The calculation produced a non-finite result.');
    return result;
  }

  private peek() {
    return this.tokens[this.position];
  }

  private next() {
    return this.tokens[this.position++];
  }

  private guard<T>(fn: () => T): T {
    if (++this.depth > 48) throw new Error('The expression nesting depth exceeded its limit.');
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private expression(): number {
    return this.guard(() => {
      let left = this.term();
      while (
        this.peek()?.kind === 'op' &&
        (this.peek() as { value: string }).value.match(/^[+-]$/)
      ) {
        const op = (this.next() as { value: string }).value;
        const right = this.term();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    });
  }

  private term(): number {
    return this.guard(() => {
      let left = this.power();
      while (
        this.peek()?.kind === 'op' &&
        ['*', '/', '%'].includes((this.peek() as { value: string }).value)
      ) {
        const op = (this.next() as { value: string }).value;
        const right = this.power();
        if ((op === '/' || op === '%') && right === 0)
          throw new Error('Division or modulo by zero is undefined.');
        left = op === '*' ? left * right : op === '/' ? left / right : left % right;
      }
      return left;
    });
  }

  private power(): number {
    return this.guard(() => {
      const base = this.unary();
      if (this.peek()?.kind === 'op' && (this.peek() as { value: string }).value === '^') {
        this.next();
        const exponent = this.power();
        return base ** exponent;
      }
      return base;
    });
  }

  private unary(): number {
    return this.guard(() => {
      if (
        this.peek()?.kind === 'op' &&
        ((this.peek() as { value: string }).value === '+' ||
          (this.peek() as { value: string }).value === '-')
      ) {
        const op = (this.next() as { value: string }).value;
        const value = this.unary();
        return op === '-' ? -value : value;
      }
      return this.primary();
    });
  }

  private primary(): number {
    const token = this.next();
    if (!token) throw new Error('Unexpected end of expression.');
    if (token.kind === 'number') return token.value;
    if (token.kind === 'paren' && token.value === '(') {
      const value = this.expression();
      const close = this.next();
      if (close?.kind !== 'paren' || close.value !== ')')
        throw new Error('Unmatched opening parenthesis.');
      return value;
    }
    if (token.kind === 'ident') {
      if (this.peek()?.kind === 'paren' && (this.peek() as { value: '(' | ')' }).value === '(') {
        const fn = Object.hasOwn(functions, token.value) ? functions[token.value] : undefined;
        if (!fn) throw new Error(`Unknown function "${token.value}".`);
        this.next();
        const args: number[] = [];
        if (!(
          this.peek()?.kind === 'paren' && (this.peek() as { value: '(' | ')' }).value === ')'
        )) {
          for (;;) {
            args.push(this.expression());
            if (args.length > 16) throw new Error('Too many function arguments.');
            if (this.peek()?.kind === 'comma') {
              this.next();
              continue;
            }
            break;
          }
        }
        const close = this.next();
        if (close?.kind !== 'paren' || close.value !== ')')
          throw new Error(`Expected closing parenthesis for ${token.value}().`);
        if (!args.length)
          throw new Error(`Function ${token.value}() requires at least one argument.`);
        return fn(...args);
      }
      if (Object.hasOwn(constants, token.value)) return constants[token.value];
      throw new Error(`Unknown identifier "${token.value}".`);
    }
    throw new Error('Invalid syntax in mathematical expression.');
  }
}

/** Evaluates a bounded mathematical expression using a deterministic parser. */
export function evaluateCalculation(expression: string, precision?: number) {
  const raw = new Parser(tokenize(expression)).parse();
  const value =
    precision !== undefined ? Number(raw.toFixed(precision)) : Number(raw.toPrecision(15));
  return {
    expression,
    result: Object.is(value, -0) ? 0 : value,
    exact: Object.is(raw, -0) ? 0 : raw,
  };
}
