/**
 * Re-exports SpacetimeDB bindings from the desktop game module.
 * When creating a new app via create-workspace-app, bindings are generated
 * into this folder. Until then, this re-export resolves the module for the template.
 */
export {
  DbConnection,
  tables,
  reducers,
} from "../../../../src/features/games/bindings";
