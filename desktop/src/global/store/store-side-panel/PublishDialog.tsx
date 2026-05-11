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
import { packageIdFromName, parseBlueprintMetadata } from "./format";
import type { StoreCategory, StoreThreadMessage } from "./types";

type PublishDialogProps = {
  open: boolean;
  blueprint: StoreThreadMessage | null;
  onClose: () => void;
  onPublished: (args: {
    messageId: string;
    releaseNumber: number;
  }) => Promise<void> | void;
};

export function PublishDialog({
  open,
  blueprint,
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

  const blueprintMeta = useMemo(
    () =>
      blueprint
        ? parseBlueprintMetadata(blueprint.text)
        : { name: "", description: "", category: null as StoreCategory | null },
    [blueprint],
  );

  // When the dialog opens (or the blueprint changes), seed the form
  // from the blueprint header so the user can just hit Publish on a
  // well-formed draft instead of retyping fields the agent already
  // produced. We re-seed on every open so a different blueprint draft
  // gets its own pre-fill rather than reusing stale state.
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
    setDisplayName(blueprintMeta.name);
    setDescription(blueprintMeta.description);
    setCategory(blueprintMeta.category ?? "");
  }, [open, blueprintMeta]);

  const ownedPackages = (myPackages ?? []) as Array<{
    packageId: string;
    displayName: string;
    description: string;
    category?: StoreCategory;
  }>;

  const handleSubmit = async () => {
    if (!blueprint) {
      showToast({
        title: "No blueprint",
        description: "Ask the Store agent to draft a blueprint first.",
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
    if (!storeApi?.publishBlueprint) {
      showToast({
        title: "Publish failed",
        description: "Publish backend is not available.",
        variant: "error",
      });
      return;
    }
    const publishArgs = {
      messageId: blueprint._id,
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
    const publishedMessageId = blueprint._id;
    const toastName = publishDisplayName;
    setSubmitting(true);
    onClose();
    showToast({
      title: "Publishing",
      description: "Stella will let you know when it's finished.",
    });
    void (async () => {
      try {
        // The worker resolves the source message → attached features →
        // commit hashes → redacted reference diffs and ships the spec
        // and diffs to Convex in one round-trip. The renderer no longer
        // talks to Convex directly here.
        const release = await storeApi.publishBlueprint(publishArgs);
        await onPublished({
          messageId: publishedMessageId,
          releaseNumber: release.releaseNumber,
        });
        showToast({
          title: "Published",
          description: `${toastName} is now in the store.`,
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
