/**
 * Re-exports SpacetimeDB bindings from the desktop game module.
 * When creating a new app via create-workspace-app, the full bindings folder
 * is copied here. Until then, this re-export resolves the module for the template.
 */
export {
  DbConnection,
  tables,
  reducers,
} from "../../../../src/features/games/bindings";
