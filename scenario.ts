// Scenario identity: the trial's viewer login, derived from the
// contest's public seeded scenario (the kit's wire.ts). The scenario
// is a pure function of SCENARIO_SEED, so this process recomputes
// exactly the viewer the suite uses: login "adaiversen", id 1000.
// No clock, no randomness anywhere — fully deterministic.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

// FNV-1a over 64 bits, the scenario's string hash.
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

// SplitMix-style finaliser for a 64-bit value.
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

// The seed for one named part of the scenario: seed XOR hash(label).
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

// xorshift64*: the scenario's PRNG, seeded from a bigint.
export class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  // Uniform integer in [0, maxExclusive), rejection-sampled so the
  // result is unbiased even when the range does not divide 2^32.
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada',
  'bram',
  'cora',
  'dmitri',
  'elena',
  'felix',
  'greta',
  'hugo',
  'iris',
  'jonas',
  'kira',
  'lars',
  'mira',
  'nico',
  'olga',
  'pavel',
  'quinn',
  'rosa',
  'sven',
  'tess',
  'ulla',
  'vito',
  'wren',
  'yara',
  'zane',
];

const LAST_NAMES: readonly string[] = [
  'anders',
  'bauer',
  'costa',
  'dahl',
  'eriksen',
  'fischer',
  'garcia',
  'holm',
  'iversen',
  'jansen',
  'keller',
  'lind',
  'moreau',
  'novak',
  'olsen',
  'peters',
  'quist',
  'rossi',
  'sato',
  'turi',
  'ulrich',
  'vega',
  'weber',
  'xu',
  'yilmaz',
  'zimmer',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

// Generate `count` users from `rng`, with unique logins. A login is
// first+last; on a collision a numeric suffix is appended.
function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// The trial's viewer (users[0]), teammate and stranger, derived
// from the seed. The suite derives the same three users the same way.
export function scenarioUsers(): { viewer: ScenarioUser; teammate: ScenarioUser; stranger: ScenarioUser } {
  const users = generateUsers(new Rng(scenarioSeedFor('users')), 12);
  return { viewer: users[0], teammate: users[1], stranger: users[2] };
}

// Fixed epoch for every timestamp this forge writes, so two runs of
// the same trial produce byte-identical state.
export const FIXED_EPOCH_SEC = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
