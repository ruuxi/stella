import { useEffect, useMemo, useState } from "react";
import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { showToast } from "@/ui/toast";
import { Select } from "@/ui/select";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { packageIdFromName } from "./format";
import type { StoreCategory } from "./types";

/**
 * One selected publishable change. `featureId` pins the selection to an
 * exact roster feature — display names are not unique, so without it two
 * same-named features would collapse onto whichever resolves first.
 */
export type PublishFeatureRef = {
  name: string;
  featureId?: string;
};

type PublishDialogProps = {
  open: boolean;
  selectedFeatures: PublishFeatureRef[];
  onClose: () => void;
  onPublished: (args: { releaseNumber: number }) => Promise<void> | void;
};

export function PublishDialog({
  open,
  selectedFeatures,
  onClose,
  onPublished,
}: PublishDialogProps) {
  // One-shot fetch when the dialog opens — the user can't be racing
  // themselves to publish from another window, so a live subscription
  // for the duration of the dialog is unnecessary.
  const myPackages = useConvexOneShot(
    api.data.store_packages.listMyPackages,
    open ? {} : "skip",
  );
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<StoreCategory | "">("");
  const [asUpdate, setAsUpdate] = useState(false);
  const [updatePackageId, setUpdatePackageId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const sourceFeatures = useMemo(() => {
    // Dedupe on featureId (falling back to name for legacy rows without
    // one) so two distinct features that happen to share a display name
    // both survive into the publish payload.
    const seen = new Set<string>();
    const features: PublishFeatureRef[] = [];
    for (const feature of selectedFeatures) {
      const name = feature.name.trim();
      if (!name) continue;
      const key = feature.featureId ?? name;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({ name, featureId: feature.featureId });
    }
    return features;
  }, [selectedFeatures]);

  const selectedFeatureName =
    sourceFeatures.length === 1 ? sourceFeatures[0]!.name : "";

  // When the dialog opens, seed the form from the selected feature. Re-seed on
  // every open so a different source selection gets its own pre-fill.
  useEffect(() => {
    if (!open) {
      setDisplayName("");
      setDescription("");
      setCategory("");
      setAsUpdate(false);
      setUpdatePackageId("");
      setSubmitting(false);
      return;
    }
    setDisplayName(selectedFeatureName);
    setDescription("");
    setCategory("");
  }, [open, selectedFeatureName]);

  const ownedPackages = (myPackages ?? []) as Array<{
    packageId: string;
    displayName: string;
    description: string;
    category?: StoreCategory;
  }>;

  const handleSubmit = async () => {
    if (sourceFeatures.length === 0) {
      showToast({
        title: "No source changes",
        description: "Select at least one recent source-backed change first.",
        variant: "error",
      });
      return;
    }

    let publishPackageId: string;
    let publishDisplayName: string;
    let publishDescription: string;
    let publishCategory: StoreCategory | undefined;

    if (asUpdate) {
      const selectedPackage = ownedPackages.find(
        (pkg) => pkg.packageId === updatePackageId.trim(),
      );
      if (!selectedPackage) {
        showToast({
          title: "Pick an add-on",
          description: "Choose the add-on you want to update.",
          variant: "error",
        });
        return;
      }
      publishPackageId = selectedPackage.packageId;
      publishDisplayName = selectedPackage.displayName;
      publishDescription = selectedPackage.description;
      publishCategory = selectedPackage.category;
    } else {
      const trimmedName = displayName.trim();
      if (!trimmedName) {
        showToast({
          title: "Name required",
          description: "Give your add-on a short name before publishing.",
          variant: "error",
        });
        return;
      }
      const slug = packageIdFromName(trimmedName);
      if (!slug) {
        showToast({
          title: "Pick a different name",
          description:
            "Use letters or numbers in the name so we can build an ID.",
          variant: "error",
        });
        return;
      }
      publishPackageId = slug;
      publishDisplayName = trimmedName;
      publishDescription = description.trim();
      publishCategory = category || undefined;
    }

    const manifest = {
      ...(publishCategory ? { category: publishCategory } : {}),
      ...(publishDescription
        ? { summary: publishDescription.slice(0, 500) }
        : {}),
    };
    const storeApi = window.electronAPI?.store;
    if (!storeApi?.publishSelectedFeatures) {
      showToast({
        title: "Publish failed",
        description: "Publish backend is not available.",
        variant: "error",
      });
      return;
    }
    const publishArgs = {
      attachedFeatureNames: sourceFeatures.map((feature) => feature.name),
      // Parallel to the names; "" marks legacy rows the worker resolves by
      // name instead.
      attachedFeatureIds: sourceFeatures.map(
        (feature) => feature.featureId ?? "",
      ),
      packageId: publishPackageId,
      asUpdate,
      manifest,
      ...(asUpdate
        ? {}
        : {
            displayName: publishDisplayName,
            ...(publishDescription ? { description: publishDescription } : {}),
            ...(publishCategory ? { category: publishCategory } : {}),
          }),
    };
    const toastName = publishDisplayName;
    setSubmitting(true);
    onClose();
    showToast({
      title: "Publishing",
      description: "Stella will let you know when it's finished.",
    });
    void (async () => {
      try {
        // The worker resolves selected feature names to commits and a
        // source pack. Renderer input is only listing metadata plus the
        // selected source refs.
        const release = await storeApi.publishSelectedFeatures(publishArgs);
        await onPublished({
          releaseNumber: release.releaseNumber,
        });
        showToast({
          title: "Submitted for review",
          description: `${toastName} was sent to the Stella team. It goes live in the store once it's approved.`,
        });
      } catch (error) {
        showToast({
          title: "Publish failed",
          description: (error as Error)?.message,
          variant: "error",
        });
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent fit className="store-publish-dialog">
        <DialogHeader>
          <DialogTitle>
            {asUpdate ? "Publish update" : "Publish to Store"}
          </DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          {ownedPackages.length > 0 ? (
            <label className="store-publish-dialog-row">
              <input
                type="checkbox"
                checked={asUpdate}
                onChange={(event) => setAsUpdate(event.target.checked)}
              />
              <span>Update an existing add-on</span>
            </label>
          ) : null}

          {asUpdate ? (
            <div className="store-publish-dialog-field">
              <span className="store-publish-dialog-field-label">
                Existing add-on
              </span>
              <Select
                value={updatePackageId}
                onValueChange={(value) => setUpdatePackageId(value)}
                aria-label="Existing add-on"
                placeholder="Select…"
                options={[
                  { value: "", label: "Select…" },
                  ...ownedPackages.map((pkg) => ({
                    value: pkg.packageId,
                    label: pkg.displayName,
                  })),
                ]}
              />
            </div>
          ) : (
            <>
              <label className="store-publish-dialog-field">
                <span className="store-publish-dialog-field-label">Name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Example mod"
                  maxLength={120}
                />
              </label>
              <label className="store-publish-dialog-field">
                <span className="store-publish-dialog-field-label">
                  Description{" "}
                  <span className="store-publish-dialog-field-hint">
                    (optional)
                  </span>
                </span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="A short line for the store listing."
                  rows={3}
                  maxLength={4_000}
                />
              </label>
              <div className="store-publish-dialog-field">
                <span className="store-publish-dialog-field-label">
                  Category
                </span>
                <Select
                  value={category}
                  onValueChange={(value) =>
                    setCategory(value as typeof category)
                  }
                  aria-label="Category"
                  placeholder="Pick a category…"
                  options={[
                    { value: "", label: "Pick a category…" },
                    { value: "apps-games", label: "Apps & games" },
                    { value: "productivity", label: "Productivity" },
                    { value: "customization", label: "Customization" },
                    { value: "skills-agents", label: "Skills & agents" },
                    { value: "integrations", label: "Integrations" },
                    { value: "other", label: "Other" },
                  ]}
                />
              </div>
            </>
          )}

          <div className="store-publish-dialog-actions">
            <button type="button" className="pill-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--primary"
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitting ? "Publishing…" : "Publish"}
            </button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
