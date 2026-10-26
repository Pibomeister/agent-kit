import type { Catalog } from "../catalog/load.ts";

/** Everything a check needs: the tree under inspection and its declared truth. */
export interface CheckContext {
  /** Absolute path to the repository root under inspection. */
  root: string;
  catalog: Catalog;
  /**
   * The project record `ak validate --project` names, as given: the record the
   * packager reads for its profile opt-in. The constitution check reads the
   * registry it names; absent, that check reports nothing.
   */
  project?: string;
}
