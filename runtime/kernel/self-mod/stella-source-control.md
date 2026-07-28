# Stella Source Control

Stella needs source control that behaves like GitHub for users without making them understand GitHub. The local install remains the source of truth. Convex and R2 only receive a package when a user shares or publishes a change.

## Current Shape

- Self-mod runs already commit local source changes and the inline undo flow reverts those commits.
- Store publishing ships a behavior spec, redacted per-commit reference diffs, and a Stella source pack when the selected commits are safe to package. When local Stella source-history rows exist, the pack preserves those revision ids and hydrates only the selected changed-file content for sharing.
- Store installation uses the source-import primitive: prepare source material, run the trust gate when needed, try the cheap clean apply, and hand structured materials to the general agent when the tree has diverged. Installed packages record both local undo commits and Stella source revision ids, so updates can pass only the revisions since the user's installed version.
- Official desktop installs are partial Git clones at the exact published commit. Desktop updates fetch `origin/master`, verify it equals the published release commit, fast-forward unchanged clones, merge compatible local commits, and hand genuine Git conflicts to the install-update agent. Native helpers and Stella Browser remain separately pinned release artifacts.
- Arbitrary imports expose the same primitive to the orchestrator as `import_source(source, scope, trust)`. Local paths and git URLs resolve into an import workspace; untrusted sources are reviewed first; merge-compatible git refs use native git as a fast path; unrelated repos or named feature extraction fall back to the general agent with the source checkout, tree listing, reference diff, and recent commits.

Official desktop delivery and Store package delivery solve different problems. Desktop releases use Git because every install shares the upstream repository and should preserve exact commit identity. Store packages use source packs because they publish selected Stella revisions and changed-file content, not a full foreign object graph.

## Target Model

### Local History

Every installed Stella carries the same base history ids for official releases. Those ids are hashes of file paths and blob hashes, not a clone of another user's full source tree. A release payload can hydrate the working tree while the history graph proves what base the user started from.

Each self-mod run appends a local revision:

- `revisionId`: hash of parent ids, feature id, description, paths, base hashes, and next hashes.
- `parentRevisionIds`: official release parent plus any feature/package parents.
- `featureId`: stable group id produced by Stella for a user-visible feature.
- `changes`: per-path base hash, next hash, and optional next content.

The local graph is private. It can diverge forever without syncing anywhere.

### Share Packs

When a user shares a Store package, Stella uploads only the selected feature revisions:

- Convex stores package metadata, release ordering, author, visibility, install counts, and moderation/review state.
- R2 stores larger source packs by content hash when the pack outgrows Convex document limits.
- A source pack contains changed-file content only for the shared feature. It does not contain unrelated files from the user's Stella.
- The release summary remains the semantic north star and review surface. The source pack is exact changed-file package material for the clean import path and, when needed, the install agent.

### Merge

Store install/update uses the source-pack shape as import input. The clean path is automatic:

1. Confirm the install has the referenced base history id.
2. For each changed path, compare the user's local blob hash to the pack's base and next hashes.
3. If local equals base, write the incoming blob.
4. If local equals next, mark the path already applied.
5. If local diverged but the edit is non-overlapping text, perform a three-way text merge.
6. If the edit overlaps, involves deletion/binary content, or the base history is missing during an official update, produce a structured conflict for the import handoff.

The Store import agent sees a Stella conflict object, not a raw Git conflict. It gets the base, local, incoming, feature metadata, and behavior spec, then writes the resolution into the local tree. Stella commits that resolution as a local revision.

Official desktop updates instead use the shared Git graph. Unchanged installs
fast-forward to the exact release SHA. Installs with local commits use a normal
three-way merge, and the install-update agent resolves only genuine conflicts.

### Git Sources

When the source is a local git repo or git URL, Stella fetches the source ref into the target repo and runs `git merge-tree --write-tree HEAD FETCH_HEAD` as the cheap path. If the ref shares history and the merge tree is clean, Stella checks out the merged tree's changed paths and commits them through the normal self-mod lifecycle. If the histories are unrelated, the working tree is dirty, the user asked for a named subset, or merge-tree reports conflicts, Stella materializes the source checkout and reference materials for the general agent instead.

### Native Artifacts

Native helpers should not be hidden inside source history. They are official desktop-update artifacts:

- `sourceRevisionId` points to source changes.
- Official desktop manifests pin native-helper and Stella Browser artifacts separately from the Git commit that identifies source.
- Desktop native-helper refresh checks latest and replaces the local helper bundle only when needed.
- Store packages do not publish or install native-helper artifacts. Store installs hand the agent a temporary package directory containing the spec, source pack, and reference diffs.

## Migration Path

1. Land the local source-control core beside the current Git-backed flow.
2. Publish Store releases with editable metadata, reference diffs, and a Stella source pack.
3. Feed Store installs and updates through the shared source-import primitive, using the source pack as the clean path and source pack plus reference diffs as exact agent input when adaptation is needed.
4. Keep official desktop install/update Git-native so upstream commit identity remains exact.
5. Keep native-helper and Stella Browser refresh in the official desktop update path.

The prototype in `stella-source-control.ts` implements the first merge primitive: content-addressed changed-file packs, stable revision ids that do not require unchanged file contents, deterministic clean apply/noop behavior, grouped revision chains for feature installs/updates, a simple three-way text merge, and structured conflicts for agent resolution. The local SQLite history graph records hash-only revisions for self-mod and Store apply commits, and Store publishing now prefers that graph so shared packs keep Stella's own revision identity instead of minting a Git-derived one at upload time.
