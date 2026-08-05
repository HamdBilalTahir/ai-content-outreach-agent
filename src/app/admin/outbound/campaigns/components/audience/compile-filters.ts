import {
  FilterGroup,
  HsFilter,
  HsFilterGroup,
  SearchFilter,
} from '../../shared';

// Operators that take no value.
export const VALUELESS_OPERATORS = new Set([
  'HAS_PROPERTY',
  'NOT_HAS_PROPERTY',
]);

// Explicit list-membership operators — carry a multi-value array; the backend
// maps the literal strings to HubSpot IN / NOT_IN.
export const IN_OPERATORS = new Set(['is in', 'is not in']);

// HubSpot CRM Search hard limits.
const MAX_GROUPS = 5;
const MAX_FILTERS_PER_GROUP = 6;
const MAX_TOTAL_FILTERS = 18;

type Node =
  | { kind: 'lit'; filter: HsFilter }
  | { kind: 'and'; children: Node[] }
  | { kind: 'or'; children: Node[] };

const lit = (filter: HsFilter): Node => ({ kind: 'lit', filter });
const and = (children: Node[]): Node => ({ kind: 'and', children });
const or = (children: Node[]): Node => ({ kind: 'or', children });

// One row → a boolean sub-expression (null if it contributes nothing).
function rowNode(f: SearchFilter): Node | null {
  if (!f.property) return null;
  if (VALUELESS_OPERATORS.has(f.operator)) {
    return lit({ propertyName: f.property, operator: f.operator });
  }
  const vals = f.values.map((v) => v.trim()).filter(Boolean);
  if (vals.length === 0) return null;
  // Explicit "is in" / "is not in" — emit HubSpot-native IN / NOT_IN with the
  // whole array as `values` (a single value still goes as a one-element array).
  // We send the native codes (not the literal "is in" strings) because that's
  // what HubSpot Search accepts directly.
  if (IN_OPERATORS.has(f.operator)) {
    return lit({
      propertyName: f.property,
      operator: f.operator === 'is not in' ? 'NOT_IN' : 'IN',
      values: vals,
    });
  }
  if (vals.length === 1) {
    return lit({
      propertyName: f.property,
      operator: f.operator,
      value: vals[0],
    });
  }
  if (f.match === 'all') {
    return and(
      vals.map((v) =>
        lit({ propertyName: f.property, operator: f.operator, value: v })
      )
    );
  }
  // match 'any' — collapse exact-match OR into a single IN/NOT_IN filter.
  if (f.operator === 'EQ')
    return lit({ propertyName: f.property, operator: 'IN', values: vals });
  if (f.operator === 'NEQ')
    return lit({ propertyName: f.property, operator: 'NOT_IN', values: vals });
  return or(
    vals.map((v) =>
      lit({ propertyName: f.property, operator: f.operator, value: v })
    )
  );
}

function groupNode(g: FilterGroup): Node | null {
  const rows = g.filters.map(rowNode).filter((n): n is Node => n !== null);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  return g.match === 'all' ? and(rows) : or(rows);
}

// Disjunctive normal form: OR of AND-terms; each term is a list of literals.
function dnf(node: Node): HsFilter[][] {
  if (node.kind === 'lit') return [[node.filter]];
  if (node.kind === 'or') return node.children.flatMap(dnf);
  // and → cartesian product of children
  return node.children.reduce<HsFilter[][]>(
    (acc, child) => {
      const cd = dnf(child);
      const out: HsFilter[][] = [];
      for (const a of acc) for (const b of cd) out.push([...a, ...b]);
      return out;
    },
    [[]]
  );
}

export interface CompileResult {
  filterGroups: HsFilterGroup[];
  error: string | null;
}

// Compile the group builder into HubSpot-ready filterGroups (OR of AND-groups).
// Empty (no usable rows) → filterGroups: [] which means "all contacts".
export function compileFilterGroups(
  groups: FilterGroup[],
  groupMatch: 'any' | 'all'
): CompileResult {
  const nodes = groups.map(groupNode).filter((n): n is Node => n !== null);
  if (nodes.length === 0) return { filterGroups: [], error: null };

  const root =
    nodes.length === 1
      ? nodes[0]
      : groupMatch === 'all'
        ? and(nodes)
        : or(nodes);

  const filterGroups = dnf(root).map((filters) => ({ filters }));

  const total = filterGroups.reduce((n, g) => n + g.filters.length, 0);
  const maxInGroup = filterGroups.reduce(
    (m, g) => Math.max(m, g.filters.length),
    0
  );
  if (
    filterGroups.length > MAX_GROUPS ||
    maxInGroup > MAX_FILTERS_PER_GROUP ||
    total > MAX_TOTAL_FILTERS
  ) {
    return {
      filterGroups,
      error:
        'Too complex for HubSpot search (max 5 groups · 6 filters each · 18 total). Simplify the OR conditions.',
    };
  }
  return { filterGroups, error: null };
}

// Does the builder have at least one usable filter? (else the audience is "all").
export function hasAnyFilter(groups: FilterGroup[]): boolean {
  return groups.some((g) => g.filters.some((f) => rowNode(f) !== null));
}
