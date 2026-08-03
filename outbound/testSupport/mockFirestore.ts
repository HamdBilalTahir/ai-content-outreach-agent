/**
 * A small in-memory Firestore double.
 *
 * Exists so outbound suites can exercise real read/write logic — dot-path memory updates, sentinel
 * values, batches, transactions, `arrayUnion` idempotency — without live credentials. It is
 * deliberately not a full emulator: it implements the operations the ported code actually uses, and
 * throws on anything it does not, so an unsupported call fails loudly instead of silently passing.
 *
 * Semantics that matter and are modelled faithfully:
 *  - `update()` REJECTS on a missing document (several ported functions rely on that to return
 *    `false`), while `set(..., {merge:true})` creates it.
 *  - `update()` honours dot-path field paths, which is how `setMemory` avoids clobbering siblings.
 *  - Sentinels (`serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `delete`) are resolved
 *    at write time, and `arrayUnion` deduplicates by deep equality as the real thing does.
 *
 * Usage — must be hoisted above the module under test:
 *
 *   jest.mock('../../firebase/db', () => require('../helpers/mockFirestore').mockDbModule());
 *   const { store } = require('../helpers/mockFirestore');
 */

type Data = Record<string, unknown>;

/** Sentinel markers, resolved when a write is applied. */
const SENTINEL = Symbol('sentinel');
type Sentinel =
  | { [SENTINEL]: 'serverTimestamp' }
  | { [SENTINEL]: 'increment'; by: number }
  | { [SENTINEL]: 'arrayUnion'; values: unknown[] }
  | { [SENTINEL]: 'arrayRemove'; values: unknown[] }
  | { [SENTINEL]: 'delete' };

function isSentinel(v: unknown): v is Sentinel {
  return (
    typeof v === 'object' &&
    v !== null &&
    SENTINEL in (v as Record<symbol, unknown>)
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Data);
  const kb = Object.keys(b as Data);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Data)[k], (b as Data)[k]));
}

function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  const out: Data = {};
  for (const [k, val] of Object.entries(v as Data)) out[k] = clone(val);
  return out as T;
}

/**
 * The document store, keyed by full path (`chats/a/tasks/b`). Exposed so tests can seed state and
 * assert on it directly.
 */
export const store = {
  docs: new Map<string, Data>(),

  reset(): void {
    this.docs.clear();
    idCounter = 0;
  },

  /** Seed (or overwrite) a document. */
  set(path: string, data: Data): void {
    this.docs.set(path, clone(data));
  },

  /** Read a document, or `undefined` if absent. */
  get(path: string): Data | undefined {
    const d = this.docs.get(path);
    return d ? clone(d) : undefined;
  },

  /** Every path under a collection path, direct children only. */
  paths(collectionPath: string): string[] {
    const prefix = `${collectionPath}/`;
    return [...this.docs.keys()].filter(
      (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')
    );
  },

  /** All documents in a collection, as `[id, data]` pairs. */
  collection(collectionPath: string): Array<[string, Data]> {
    return this.paths(collectionPath).map((p) => [
      p.slice(collectionPath.length + 1),
      clone(this.docs.get(p)!),
    ]);
  },
};

let idCounter = 0;
function autoId(): string {
  idCounter += 1;
  return `auto${String(idCounter).padStart(4, '0')}`;
}

/** Apply an update payload, resolving sentinels and honouring dot-path field paths. */
function applyUpdate(target: Data, updates: Data): void {
  for (const [key, rawValue] of Object.entries(updates)) {
    const segments = key.split('.');
    let cursor: Data = target;
    for (const seg of segments.slice(0, -1)) {
      if (
        typeof cursor[seg] !== 'object' ||
        cursor[seg] === null ||
        Array.isArray(cursor[seg])
      ) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Data;
    }
    const leaf = segments[segments.length - 1];

    if (isSentinel(rawValue)) {
      const s = rawValue as Record<string, unknown> & { [SENTINEL]: string };
      switch (s[SENTINEL]) {
        case 'serverTimestamp':
          cursor[leaf] = new Date();
          break;
        case 'increment':
          cursor[leaf] = Number(cursor[leaf] ?? 0) + Number(s.by);
          break;
        case 'arrayUnion': {
          const existing = Array.isArray(cursor[leaf])
            ? (cursor[leaf] as unknown[])
            : [];
          const next = [...existing];
          for (const v of s.values as unknown[]) {
            if (!next.some((e) => deepEqual(e, v))) next.push(clone(v));
          }
          cursor[leaf] = next;
          break;
        }
        case 'arrayRemove': {
          const existing = Array.isArray(cursor[leaf])
            ? (cursor[leaf] as unknown[])
            : [];
          cursor[leaf] = existing.filter(
            (e) => !(s.values as unknown[]).some((v) => deepEqual(e, v))
          );
          break;
        }
        case 'delete':
          delete cursor[leaf];
          break;
        default:
          throw new Error(
            `mockFirestore: unknown sentinel ${String(s[SENTINEL])}`
          );
      }
      continue;
    }

    cursor[leaf] = clone(rawValue);
  }
}

function deepMerge(target: Data, source: Data): void {
  for (const [k, v] of Object.entries(source)) {
    if (isSentinel(v)) {
      applyUpdate(target, { [k]: v });
      continue;
    }
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Date)
    ) {
      if (
        typeof target[k] !== 'object' ||
        target[k] === null ||
        Array.isArray(target[k])
      ) {
        target[k] = {};
      }
      deepMerge(target[k] as Data, v as Data);
      continue;
    }
    target[k] = clone(v);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query / reference objects
// ─────────────────────────────────────────────────────────────────────────────

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

function readField(data: Data, field: string): unknown {
  return field.split('.').reduce<unknown>((acc, seg) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Data)[seg];
  }, data);
}

function matches(data: Data, filters: Filter[]): boolean {
  return filters.every(({ field, op, value }) => {
    const actual = readField(data, field);
    switch (op) {
      case '==':
        return deepEqual(actual, value);
      case '!=':
        return !deepEqual(actual, value);
      case '>':
        return compare(actual, value) > 0;
      case '>=':
        return compare(actual, value) >= 0;
      case '<':
        return compare(actual, value) < 0;
      case '<=':
        return compare(actual, value) <= 0;
      case 'in':
        return (value as unknown[]).some((v) => deepEqual(actual, v));
      case 'not-in':
        return !(value as unknown[]).some((v) => deepEqual(actual, v));
      case 'array-contains':
        return Array.isArray(actual) && actual.some((v) => deepEqual(v, value));
      default:
        throw new Error(`mockFirestore: unsupported operator ${op}`);
    }
  });
}

/** The last path segment — a document's ID. */
function docIdOf(path: string): string {
  return path.split('/').pop()!;
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === undefined || av === null) return -1;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
}

class MockSnapshot {
  constructor(
    readonly id: string,
    private readonly _data: Data | undefined,
    readonly ref: MockDocRef
  ) {}

  get exists(): boolean {
    return this._data !== undefined;
  }

  data(): Data | undefined {
    return this._data ? clone(this._data) : undefined;
  }
}

class MockQuery {
  constructor(
    protected readonly collectionPath: string,
    protected readonly filters: Filter[] = [],
    protected readonly orders: Array<{ field: string; dir: string }> = [],
    protected readonly limitN: number | null = null,
    protected readonly isGroup = false,
    protected readonly after: string | null = null
  ) {}

  where(field: string, op: string, value: unknown): MockQuery {
    return new MockQuery(
      this.collectionPath,
      [...this.filters, { field, op, value }],
      this.orders,
      this.limitN,
      this.isGroup,
      this.after
    );
  }

  orderBy(field: string, dir = 'asc'): MockQuery {
    return new MockQuery(
      this.collectionPath,
      this.filters,
      [...this.orders, { field, dir }],
      this.limitN,
      this.isGroup,
      this.after
    );
  }

  limit(n: number): MockQuery {
    return new MockQuery(
      this.collectionPath,
      this.filters,
      this.orders,
      n,
      this.isGroup,
      this.after
    );
  }

  /**
   * Cursor paging, modelled for `__name__` ordering only.
   *
   * That is the one form the ported code uses — the conversion scan pages id-ordered outbound chats and
   * hands the last id back as a resume cursor. Modelling it for real matters because the resume is the
   * whole point of that endpoint: a no-op `startAfter` would make every page return page one, and a test
   * that walked to exhaustion would loop forever or silently pass on one page.
   *
   * Anything else THROWS rather than silently ignoring the cursor — three earlier gaps in this double
   * were invisible precisely because a missing operation looked like passing code.
   */
  startAfter(cursor: unknown): MockQuery {
    if (!this.orders.some((o) => o.field === '__name__')) {
      throw new Error(
        'mockFirestore: startAfter is modelled only for orderBy("__name__")'
      );
    }
    let id: string;
    if (typeof cursor === 'string') {
      id = cursor;
    } else if (
      cursor &&
      typeof cursor === 'object' &&
      '__name__' in (cursor as Record<string, unknown>)
    ) {
      id = String((cursor as Record<string, unknown>).__name__);
    } else {
      throw new Error(
        'mockFirestore: startAfter takes an id string or {__name__: id}'
      );
    }
    return new MockQuery(
      this.collectionPath,
      this.filters,
      this.orders,
      this.limitN,
      this.isGroup,
      id
    );
  }

  private candidatePaths(): string[] {
    if (!this.isGroup) return store.paths(this.collectionPath);
    // A collection-group query matches any path whose final collection segment equals the name.
    return [...store.docs.keys()].filter((p) => {
      const segs = p.split('/');
      return segs.length >= 2 && segs[segs.length - 2] === this.collectionPath;
    });
  }

  async get(): Promise<{ docs: MockSnapshot[]; empty: boolean; size: number }> {
    let rows = this.candidatePaths()
      .map((p) => ({ path: p, data: store.docs.get(p)! }))
      .filter((r) => matches(r.data, this.filters));

    for (const { field, dir } of [...this.orders].reverse()) {
      rows = rows.sort((a, b) => {
        // `__name__` orders by document ID, which is not a field in the data.
        const av =
          field === '__name__' ? docIdOf(a.path) : readField(a.data, field);
        const bv =
          field === '__name__' ? docIdOf(b.path) : readField(b.data, field);
        const c = compare(av, bv);
        return dir === 'desc' ? -c : c;
      });
    }

    // The cursor is applied AFTER ordering and BEFORE the limit, as Firestore does. Positioned by
    // VALUE comparison, not by finding the document: a cursor id that no longer exists (the chat was
    // deleted between pages) must still position the next page correctly rather than returning nothing.
    if (this.after !== null) {
      const desc = this.orders.some(
        (o) => o.field === '__name__' && o.dir === 'desc'
      );
      const cursor = this.after;
      rows = rows.filter((r) =>
        desc ? docIdOf(r.path) < cursor : docIdOf(r.path) > cursor
      );
    }

    if (this.limitN !== null) rows = rows.slice(0, this.limitN);

    const docs = rows.map((r) => {
      const segs = r.path.split('/');
      return new MockSnapshot(
        segs[segs.length - 1],
        r.data,
        new MockDocRef(r.path)
      );
    });
    return { docs, empty: docs.length === 0, size: docs.length };
  }

  /** `stream()` in the source becomes an async iterable here. */
  async *stream(): AsyncGenerator<MockSnapshot> {
    for (const d of (await this.get()).docs) yield d;
  }
}

class MockCollectionRef extends MockQuery {
  constructor(private readonly path: string) {
    super(path);
  }

  get id(): string {
    return this.path.split('/').pop()!;
  }

  doc(id?: string): MockDocRef {
    return new MockDocRef(`${this.path}/${id ?? autoId()}`);
  }

  /**
   * Every document reference in the collection, IDs only — the real `listDocuments()` reads no
   * field data. `upsertAreaCodes` uses it to learn which codes already exist so it can stamp
   * `created_at` on new documents only.
   */
  async listDocuments(): Promise<MockDocRef[]> {
    return store.paths(this.path).map((p) => new MockDocRef(p));
  }
}

class MockDocRef {
  constructor(readonly path: string) {}

  get id(): string {
    return this.path.split('/').pop()!;
  }

  /** The parent collection of this document. */
  get parent(): MockCollectionRef & { parent: MockDocRef | null } {
    const segs = this.path.split('/');
    const collectionPath = segs.slice(0, -1).join('/');
    const col = new MockCollectionRef(collectionPath) as MockCollectionRef & {
      parent: MockDocRef | null;
    };
    // A subcollection's parent document, or null for a top-level collection.
    const parentSegs = segs.slice(0, -2);
    Object.defineProperty(col, 'parent', {
      value:
        parentSegs.length >= 2 ? new MockDocRef(parentSegs.join('/')) : null,
    });
    return col;
  }

  collection(name: string): MockCollectionRef {
    return new MockCollectionRef(`${this.path}/${name}`);
  }

  async get(): Promise<MockSnapshot> {
    return new MockSnapshot(this.id, store.docs.get(this.path), this);
  }

  /**
   * Faithful to Firestore: `create()` REJECTS when the document already exists. That rejection is
   * how the outbound chat creator resolves a concurrent-create race — only one caller wins, and the
   * loser's error is expected and swallowed.
   */
  async create(data: Data): Promise<void> {
    if (store.docs.has(this.path)) {
      throw new Error(`ALREADY_EXISTS: document already exists: ${this.path}`);
    }
    const fresh: Data = {};
    deepMerge(fresh, data);
    store.docs.set(this.path, fresh);
  }

  async set(data: Data, options?: { merge?: boolean }): Promise<void> {
    if (options?.merge) {
      const existing = store.docs.get(this.path) ?? {};
      deepMerge(existing, data);
      store.docs.set(this.path, existing);
      return;
    }
    const fresh: Data = {};
    deepMerge(fresh, data);
    store.docs.set(this.path, fresh);
  }

  async update(updates: Data): Promise<void> {
    const existing = store.docs.get(this.path);
    if (existing === undefined) {
      // Faithful to Firestore: update() on a missing document rejects. Several ported functions
      // depend on this to report `false` for a chat/task that no longer exists.
      throw new Error(`NOT_FOUND: no document to update: ${this.path}`);
    }
    applyUpdate(existing, updates);
    store.docs.set(this.path, existing);
  }

  async delete(): Promise<void> {
    store.docs.delete(this.path);
  }
}

class MockBatch {
  private readonly ops: Array<() => Promise<void>> = [];

  set(ref: MockDocRef, data: Data, options?: { merge?: boolean }): MockBatch {
    this.ops.push(() => ref.set(data, options));
    return this;
  }

  update(ref: MockDocRef, updates: Data): MockBatch {
    this.ops.push(() => ref.update(updates));
    return this;
  }

  delete(ref: MockDocRef): MockBatch {
    this.ops.push(() => ref.delete());
    return this;
  }

  async commit(): Promise<void> {
    for (const op of this.ops) await op();
  }
}

class MockTransaction {
  async get(ref: MockDocRef): Promise<MockSnapshot> {
    return ref.get();
  }

  set(ref: MockDocRef, data: Data, options?: { merge?: boolean }): void {
    void ref.set(data, options);
  }

  update(ref: MockDocRef, updates: Data): void {
    void ref.update(updates);
  }

  delete(ref: MockDocRef): void {
    void ref.delete();
  }
}

export const mockDb = {
  collection: (path: string) => new MockCollectionRef(path),
  collectionGroup: (name: string) => new MockQuery(name, [], [], null, true),
  doc: (path: string) => new MockDocRef(path),
  batch: () => new MockBatch(),

  /**
   * Transactions run the callback once with no retry. The ported code's transactional guards are
   * tested for their decision logic, not for contention behaviour.
   */
  runTransaction: async <T>(
    fn: (tx: MockTransaction) => Promise<T>
  ): Promise<T> => fn(new MockTransaction()),

  getAll: async (...refs: MockDocRef[]): Promise<MockSnapshot[]> =>
    Promise.all(refs.map((r) => r.get())),
};

export const mockFieldValue = {
  serverTimestamp: () => ({ [SENTINEL]: 'serverTimestamp' }),
  increment: (by: number) => ({ [SENTINEL]: 'increment', by }),
  arrayUnion: (...values: unknown[]) => ({ [SENTINEL]: 'arrayUnion', values }),
  arrayRemove: (...values: unknown[]) => ({
    [SENTINEL]: 'arrayRemove',
    values,
  }),
  delete: () => ({ [SENTINEL]: 'delete' }),
};

/**
 * The module shape to substitute for `outbound/firebase/db`.
 * Mirrors its real exports so the modules under test need no changes.
 */
export function mockDbModule() {
  return {
    db: mockDb,
    FieldValue: mockFieldValue,
    Timestamp: class {},
    BATCH_LIMIT: 500,
    toDate: (v: unknown) => {
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return v;
      if (typeof v === 'string' || typeof v === 'number') {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return null;
    },
    getAllChunked: async (refs: MockDocRef[]) =>
      Promise.all(refs.map((r) => r.get())),
    runWithConcurrency: async <T>(
      tasks: Array<() => Promise<T>>
    ): Promise<T[]> => {
      const out: T[] = [];
      for (const t of tasks) out.push(await t());
      return out;
    },
  };
}
