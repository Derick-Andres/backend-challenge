import { isCurrencyCode } from './iso-currencies.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  override readonly name = 'InvalidMoneyError';
}

export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';

  constructor() {
    super('Operações e comparações de Money exigem a mesma moeda');
  }
}

const externalAmount = /^(?:0|[1-9][0-9]*)\.[0-9]{2}$/;

export class Money {
  readonly #minorUnits: bigint;
  readonly currency: string;

  private constructor(minorUnits: bigint, currency: string) {
    this.#minorUnits = minorUnits;
    this.currency = currency;
    Object.freeze(this);
  }

  // Fronteira externa: formato canônico, sem sinal ou coerção de tipos.
  static from(props: unknown): Money {
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new InvalidMoneyError('Money exige um objeto com amount e currency');
    }
    const { amount, currency } = props as Record<string, unknown>;
    if (typeof amount !== 'string' || !externalAmount.test(amount)) {
      throw new InvalidMoneyError('amount deve ser string decimal não negativa com duas casas');
    }
    Money.assertCurrency(currency);
    return new Money(BigInt(amount.replace('.', '')), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  // Reconstrói a representação interna assinada; não aplica regras de entrada externa.
  static rehydrate(minorUnits: bigint, currency: string): Money {
    if (typeof minorUnits !== 'bigint') {
      throw new InvalidMoneyError('Centavos internos devem ser bigint');
    }
    Money.assertCurrency(currency);
    return new Money(minorUnits, currency);
  }

  get minorUnits(): bigint {
    return this.#minorUnits;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#minorUnits + other.#minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#minorUnits - other.#minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.#minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.#minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.#minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.#minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#minorUnits < other.#minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#minorUnits === other.#minorUnits;
  }

  toJSON(): MoneyProps {
    const negative = this.#minorUnits < 0n;
    const absolute = negative ? -this.#minorUnits : this.#minorUnits;
    const amount = `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
    return { amount, currency: this.currency };
  }

  toString(): string {
    return `${this.toJSON().amount} ${this.currency}`;
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (!isCurrencyCode(currency)) {
      throw new InvalidMoneyError('currency deve ser um código ISO 4217 válido em maiúsculas');
    }
  }

  private assertSameCurrency(other: Money): void {
    if (!(other instanceof Money)) throw new InvalidMoneyError('Operando deve ser Money');
    if (other.currency !== this.currency) throw new CurrencyMismatchError();
  }
}
