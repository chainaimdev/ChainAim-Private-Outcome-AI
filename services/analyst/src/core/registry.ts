/**
 * Pack registry: holds the domain packs the composition root registers and resolves a pack id to its effective rules by
 * following `extends` explicitly. Merge rule: a field set on a child replaces the parent's field whole (no deep merge), so
 * the effective value of every field comes from exactly one pack, reported in `from` (shown by --print-pack).
 * Refuses: duplicate ids, unknown ids or parents, cycles, chains deeper than maxDepth, a field no pack in the chain sets.
 */
import { OPTIONAL_PACK_FIELDS, PACK_FIELDS, type DomainPack, type PackField, type ResolvedPack, type SourceAdapter } from "./ports.ts";

export class PackError extends Error {}

export class PackRegistry {
  private readonly packs = new Map<string, DomainPack>();
  readonly maxDepth: number;
  constructor(maxDepth = 3) { this.maxDepth = maxDepth; }

  register(pack: DomainPack): this {
    if (!pack.id || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(pack.id)) throw new PackError(`pack id "${pack.id}" must be lower-case words with - and /`);
    if (this.packs.has(pack.id)) throw new PackError(`pack ${pack.id} is registered twice`);
    this.packs.set(pack.id, pack);
    return this;
  }

  list(): string[] { return [...this.packs.keys()].sort(); }

  resolve(id: string): ResolvedPack {
    const chain: DomainPack[] = [];
    for (let at: string | undefined = id; at !== undefined;) {
      const p = this.packs.get(at);
      if (!p) throw new PackError(chain.length ? `pack ${chain[chain.length - 1].id} extends unknown pack ${at}` : `unknown pack ${at} (known: ${this.list().join(", ") || "none"})`);
      if (chain.some((c) => c.id === at)) throw new PackError(`pack ${id}: extends cycle ${[...chain.map((c) => c.id), at].join(" -> ")}`);
      chain.push(p);
      if (chain.length > this.maxDepth) throw new PackError(`pack ${id}: extends chain longer than ${this.maxDepth} (${chain.map((c) => c.id).join(" -> ")})`);
      at = p.extends;
    }
    const out: Record<string, unknown> = { id, title: chain[0].title, chain: chain.map((c) => c.id), from: {} };
    for (const f of PACK_FIELDS) {
      const owner = chain.find((c) => c[f] !== undefined);
      if (!owner) throw new PackError(`pack ${id}: no pack in ${chain.map((c) => c.id).join(" -> ")} sets ${f}`);
      out[f] = owner[f];
      (out.from as Record<string, string>)[f] = owner.id;
    }
    for (const f of OPTIONAL_PACK_FIELDS) {
      const owner = chain.find((c) => c[f] !== undefined);
      if (owner) { out[f] = owner[f]; (out.from as Record<string, string>)[f] = owner.id; }
    }
    return out as ResolvedPack;
  }

  /** The effective pack as plain JSON (patterns as their source text), with where each field came from. */
  describe(id: string): unknown {
    const r = this.resolve(id);
    const re = (x: RegExp) => `/${x.source}/${x.flags}`;
    return {
      id: r.id, title: r.title, chain: r.chain, from: r.from,
      ...(r.reconcile !== undefined ? { reconcile: r.reconcile } : {}),
      ...(r.sourceConfigs !== undefined ? { sourceConfigs: r.sourceConfigs } : {}),
      kinds: r.kinds, flowOrder: r.flowOrder, excludeFromFlow: r.excludeFromFlow, fallbackKind: r.fallbackKind, defaultMeasure: r.defaultMeasure,
      nameHints: r.nameHints.map(([k, x]) => [k, re(x)]), kindHints: r.kindHints.map(([k, x]) => [k, re(x)]), partyPriority: r.partyPriority.map(re),
    };
  }
}

/** File layouts the composition root registers; finds the one adapter that recognises a file. */
export class SourceRegistry {
  private readonly sources = new Map<string, SourceAdapter>();
  register(a: SourceAdapter): this {
    if (this.sources.has(a.id)) throw new PackError(`source ${a.id} is registered twice`);
    this.sources.set(a.id, a);
    return this;
  }
  get(id: string): SourceAdapter {
    const a = this.sources.get(id);
    if (!a) throw new PackError(`unknown source ${id} (known: ${this.list().join(", ")})`);
    return a;
  }
  list(): string[] { return [...this.sources.keys()].sort(); }
  /** Every adapter that recognises these lines; more than one is a layout conflict for the caller to report. */
  detect(firstLines: readonly string[]): SourceAdapter[] { return [...this.sources.values()].filter((a) => a.detect(firstLines)); }
}
