import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";

import {
  formatPrice,
  formatPriceCents,
  useFashionCart,
  useFashionCheckoutAction,
  useFashionFeatureStatus,
  useFashionLikes,
  useFashionMutations,
  useFashionOutfits,
  useFashionProfile,
  type FashionCartItem,
  type FashionOutfit,
  type FashionOutfitProduct,
} from "./use-fashion-data";
import "./fashion.css";

const SIZE_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "top", label: "Top", placeholder: "M" },
  { key: "bottom", label: "Bottom", placeholder: "32" },
  { key: "shoe", label: "Shoes", placeholder: "10" },
  { key: "dress", label: "Dress", placeholder: "S" },
  { key: "outerwear", label: "Outerwear", placeholder: "M" },
  { key: "ring", label: "Ring", placeholder: "8" },
];

const GENDER_OPTIONS = [
  { value: "", label: "Select one" },
  { value: "women", label: "Women" },
  { value: "men", label: "Men" },
  { value: "unisex", label: "Unisex / no preference" },
  { value: "nonbinary", label: "Non-binary" },
];

const useLocalImageDataUrl = (filePath: string | undefined) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    if (!filePath) return;
    if (/^(https?:|data:)/i.test(filePath)) {
      setDataUrl(filePath);
      return;
    }
    const api = (window as {
      electronAPI?: {
        fashion?: {
          getLocalImageDataUrl?: (path: string) => Promise<string>;
        };
      };
    }).electronAPI;
    if (!api?.fashion?.getLocalImageDataUrl) return;
    void api.fashion
      .getLocalImageDataUrl(filePath)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return dataUrl;
};

const HeroPlaceholder = ({
  status,
  errorMessage,
}: {
  status: FashionOutfit["status"];
  errorMessage?: string;
}) => {
  if (status === "failed") {
    return (
      <div className="fashion-stage-failed">
        Couldn’t generate this look
        {errorMessage ? (
          <div style={{ marginTop: 6, opacity: 0.7 }}>{errorMessage}</div>
        ) : null}
      </div>
    );
  }
  return <div className="fashion-stage-placeholder">Styling your look…</div>;
};

const Product = ({
  product,
  liked,
  inCart,
  onLike,
  onAddToCart,
  onOpen,
}: {
  product: FashionOutfitProduct;
  liked: boolean;
  inCart: boolean;
  onLike: () => void;
  onAddToCart: () => void;
  onOpen: () => void;
}) => {
  return (
    <div className="fashion-product">
      <button
        type="button"
        className="fashion-product-thumb"
        onClick={onOpen}
        aria-label={`Open ${product.title}`}
        style={{ border: "none", padding: 0, cursor: "default" }}
      >
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" />
        ) : (
          <div className="fashion-product-thumb-empty">no image</div>
        )}
      </button>
      <div className="fashion-product-meta">
        <div className="fashion-product-slot">{product.slot}</div>
        <div className="fashion-product-title" title={product.title}>
          {product.title}
        </div>
        {product.vendor ? (
          <div className="fashion-product-vendor">{product.vendor}</div>
        ) : null}
        {typeof product.price === "number" ? (
          <div className="fashion-product-price">
            {formatPrice(product.price, product.currency)}
          </div>
        ) : null}
      </div>
      <div className="fashion-product-actions">
        <button
          type="button"
          className="fashion-icon-btn"
          data-active={liked ? "true" : undefined}
          onClick={onLike}
          aria-label={liked ? "Unlike" : "Like"}
          title={liked ? "Unlike" : "Like"}
        >
          ♥
        </button>
        <button
          type="button"
          className="fashion-icon-btn"
          data-active={inCart ? "true" : undefined}
          onClick={onAddToCart}
          aria-label={inCart ? "In cart" : "Add to cart"}
          title={inCart ? "In cart" : "Add to cart"}
        >
          +
        </button>
      </div>
    </div>
  );
};

const OutfitStage = ({
  outfit,
  likedVariantIds,
  cartVariantIds,
  onLike,
  onAddToCart,
}: {
  outfit: FashionOutfit;
  likedVariantIds: Set<string>;
  cartVariantIds: Set<string>;
  onLike: (product: FashionOutfitProduct) => void;
  onAddToCart: (product: FashionOutfitProduct) => void;
}) => {
  const products = outfit.products ?? [];
  const half = Math.ceil(products.length / 2);
  const left = products.slice(0, half);
  const right = products.slice(half);
  const localTryOnSrc = useLocalImageDataUrl(outfit.tryOnImagePath);
  const tryOnSrc = outfit.tryOnImageUrl ?? localTryOnSrc;

  const handleOpen = useCallback((product: FashionOutfitProduct) => {
    const url = product.productUrl ?? product.checkoutUrl;
    if (!url || typeof window === "undefined") return;
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  return (
    <section className="fashion-stage">
      <div className="fashion-stage-meta">
        <div>
          <div className="fashion-stage-theme">{outfit.themeLabel}</div>
          {outfit.themeDescription ? (
            <div className="fashion-stage-subtitle">
              {outfit.themeDescription}
            </div>
          ) : null}
        </div>
        <div className="fashion-stage-status" data-state={outfit.status}>
          {outfit.status === "ready"
            ? products.length === 0
              ? "Try-on"
              : `${products.length} pieces`
            : outfit.status === "generating"
              ? "Generating"
              : "Failed"}
        </div>
      </div>

      <div className="fashion-stage-side" data-align="left">
        {left.map((p) => (
          <Product
            key={`${outfit._id}-${p.variantId}-${p.slot}-l`}
            product={p}
            liked={likedVariantIds.has(p.variantId)}
            inCart={cartVariantIds.has(p.variantId)}
            onLike={() => onLike(p)}
            onAddToCart={() => onAddToCart(p)}
            onOpen={() => handleOpen(p)}
          />
        ))}
      </div>

      <div className="fashion-stage-hero">
        {tryOnSrc ? (
          <img src={tryOnSrc} alt="Try-on look" />
        ) : (
          <HeroPlaceholder
            status={outfit.status}
            errorMessage={outfit.errorMessage}
          />
        )}
      </div>

      <div className="fashion-stage-side" data-align="right">
        {right.map((p) => (
          <Product
            key={`${outfit._id}-${p.variantId}-${p.slot}-r`}
            product={p}
            liked={likedVariantIds.has(p.variantId)}
            inCart={cartVariantIds.has(p.variantId)}
            onLike={() => onLike(p)}
            onAddToCart={() => onAddToCart(p)}
            onOpen={() => handleOpen(p)}
          />
        ))}
      </div>
    </section>
  );
};

const ProfileSheet = ({
  initialGender,
  initialSizes,
  initialPrefs,
  hasBodyPhoto,
  bodyPhotoDataUrl,
  onPickPhoto,
  onSave,
  onClose,
  saving,
}: {
  initialGender: string;
  initialSizes: Record<string, string>;
  initialPrefs: string;
  hasBodyPhoto: boolean;
  bodyPhotoDataUrl: string | null;
  onPickPhoto: () => void;
  onSave: (
    gender: string,
    sizes: Record<string, string>,
    stylePreferences: string,
  ) => void;
  onClose: () => void;
  saving: boolean;
}) => {
  const [gender, setGender] = useState(initialGender);
  const [sizes, setSizes] = useState<Record<string, string>>(initialSizes);
  const [prefs, setPrefs] = useState(initialPrefs);

  useEffect(() => {
    setGender(initialGender);
    setSizes(initialSizes);
    setPrefs(initialPrefs);
  }, [initialGender, initialSizes, initialPrefs]);

  return (
    <div
      className="fashion-sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fashion-sheet" role="dialog" aria-label="Style profile">
        <div className="fashion-sheet-header">
          <div>
            <div className="fashion-sheet-title">Your style profile</div>
            <div className="fashion-sheet-subtitle">
              One full-body photo powers the try-ons. Gender guides product
              searches, and your photo stays on this Mac.
            </div>
          </div>
          <button
            type="button"
            className="fashion-sheet-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="fashion-sheet-grid">
          <button
            type="button"
            className="fashion-photo-slot"
            onClick={onPickPhoto}
            aria-label="Pick body photo"
          >
            {bodyPhotoDataUrl ? (
              <>
                <img src={bodyPhotoDataUrl} alt="" />
                <div className="fashion-photo-overlay">Replace photo</div>
              </>
            ) : hasBodyPhoto ? (
              <div>Photo saved · click to replace</div>
            ) : (
              <div>Click to pick a full-body photo</div>
            )}
          </button>

          <div className="fashion-fields">
            <div>
              <label className="fashion-field-label">Gender</label>
              <select
                className="fashion-size-input"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
              >
                {GENDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="fashion-field-label">Sizes</label>
              <div className="fashion-size-grid">
                {SIZE_FIELDS.map((f) => (
                  <input
                    key={f.key}
                    className="fashion-size-input"
                    placeholder={`${f.label} · ${f.placeholder}`}
                    value={sizes[f.key] ?? ""}
                    onChange={(e) =>
                      setSizes((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="fashion-field-label">Style notes</label>
              <textarea
                className="fashion-prefs-textarea"
                placeholder="What you like, brands, fits to avoid…"
                value={prefs}
                onChange={(e) => setPrefs(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="fashion-sheet-actions">
          <button
            type="button"
            className="fashion-sheet-save"
            onClick={() => {
              const cleaned: Record<string, string> = {};
              for (const [k, v] of Object.entries(sizes)) {
                const t = v.trim();
                if (t) cleaned[k] = t;
              }
              onSave(gender.trim(), cleaned, prefs.trim());
            }}
            disabled={saving || !gender.trim()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};

const CartDock = ({
  cart,
  onCheckout,
  busy,
  onSetQuantity,
  onRemove,
}: {
  cart: FashionCartItem[];
  onCheckout: () => void;
  busy: boolean;
  onSetQuantity: (item: FashionCartItem, quantity: number) => void;
  onRemove: (item: FashionCartItem) => void;
}) => {
  const [open, setOpen] = useState(false);
  const totalCount = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart],
  );
  const totalLabel = useMemo(() => {
    const pricedItems = cart.filter((item) => typeof item.priceCents === "number");
    if (pricedItems.length === 0) return null;
    const currencies = new Set(
      pricedItems.map((item) => (item.currency ?? "USD").toUpperCase()),
    );
    if (currencies.size !== 1) return null;
    const totalCents = pricedItems.reduce(
      (sum, item) => sum + item.priceCents! * Math.max(item.quantity, 0),
      0,
    );
    if (totalCents <= 0) return null;
    return formatPriceCents(totalCents, currencies.values().next().value);
  }, [cart]);

  if (cart.length === 0) return null;

  return (
    <div className="fashion-cart-dock">
      {open ? (
        <div className="fashion-cart-list">
          {cart.map((item) => (
            <div key={item._id} className="fashion-cart-item">
              <div className="fashion-cart-item-meta">
                <span className="fashion-cart-item-title">{item.title}</span>
                {typeof item.priceCents === "number" ? (
                  <span className="fashion-cart-item-price">
                    {formatPriceCents(item.priceCents, item.currency)}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className="fashion-cart-qty-btn"
                onClick={() => onSetQuantity(item, Math.max(0, item.quantity - 1))}
                aria-label="Decrease quantity"
              >
                −
              </button>
              <span style={{ minWidth: 14, textAlign: "center", fontSize: 12 }}>
                {item.quantity}
              </span>
              <button
                type="button"
                className="fashion-cart-qty-btn"
                onClick={() => onSetQuantity(item, item.quantity + 1)}
                aria-label="Increase quantity"
              >
                +
              </button>
              <button
                type="button"
                className="fashion-cart-qty-btn"
                onClick={() => onRemove(item)}
                aria-label="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="fashion-cart-pill">
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "inherit",
            cursor: "default",
          }}
        >
          {totalCount} item{totalCount === 1 ? "" : "s"}
          {totalLabel ? <span> · {totalLabel}</span> : null}
        </button>
        <button
          type="button"
          className="fashion-cart-checkout"
          onClick={onCheckout}
          disabled={busy}
        >
          {busy ? "Opening…" : "Checkout"}
        </button>
      </div>
    </div>
  );
};

export const FashionTab = () => {
  const featureStatus = useFashionFeatureStatus();
  const profile = useFashionProfile();
  const outfits = useFashionOutfits();
  const likes = useFashionLikes();
  const cart = useFashionCart();
  const mutations = useFashionMutations();
  const checkoutAction = useFashionCheckoutAction();

  const [bodyPhotoDataUrl, setBodyPhotoDataUrl] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [pickingPhoto, setPickingPhoto] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [tryOnImagePaths, setTryOnImagePaths] = useState<string[]>([]);
  const [tryOnImageUrls, setTryOnImageUrls] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [pickingTryOn, setPickingTryOn] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [bodyPhotoPath, setBodyPhotoPath] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const lastPhotoRefresh = useRef<number | null>(null);

  const refreshBodyPhotoPreview = useCallback(async () => {
    const api = (window as {
      electronAPI?: {
        fashion?: {
          getBodyPhotoDataUrl?: () => Promise<string | null>;
          getBodyPhotoInfo?: () => Promise<{
            hasBodyPhoto: boolean;
            absolutePath?: string;
          }>;
        };
      };
    }).electronAPI;
    if (!api?.fashion?.getBodyPhotoDataUrl) return;
    try {
      const [url, info] = await Promise.all([
        api.fashion.getBodyPhotoDataUrl(),
        api.fashion.getBodyPhotoInfo?.(),
      ]);
      setBodyPhotoDataUrl(url ?? null);
      setBodyPhotoPath(info?.absolutePath ?? null);
    } catch {
      setBodyPhotoDataUrl(null);
      setBodyPhotoPath(null);
    }
  }, []);

  useEffect(() => {
    if (!profile?.hasBodyPhoto) {
      setBodyPhotoDataUrl(null);
      setBodyPhotoPath(null);
      lastPhotoRefresh.current = null;
      return;
    }
    const updatedAt = profile.bodyPhotoUpdatedAt ?? 0;
    if (updatedAt === lastPhotoRefresh.current) return;
    lastPhotoRefresh.current = updatedAt;
    void refreshBodyPhotoPreview();
  }, [profile?.hasBodyPhoto, profile?.bodyPhotoUpdatedAt, refreshBodyPhotoPreview]);

  const handlePickPhoto = useCallback(async () => {
    const api = (window as {
      electronAPI?: {
        fashion?: { pickAndSaveBodyPhoto?: () => Promise<unknown> };
      };
    }).electronAPI;
    if (!api?.fashion?.pickAndSaveBodyPhoto) return;
    setPickingPhoto(true);
    try {
      const result = (await api.fashion.pickAndSaveBodyPhoto()) as
        | { canceled: true }
        | {
            canceled: false;
            info: {
              hasBodyPhoto: boolean;
              absolutePath?: string;
              mimeType?: string;
              updatedAt?: number;
            };
          };
      if (result && "canceled" in result && result.canceled === false) {
        setBodyPhotoPath(result.info.absolutePath ?? null);
        await mutations.setBodyPhotoFlag({
          hasBodyPhoto: true,
          ...(result.info.mimeType !== undefined
            ? { bodyPhotoMimeType: result.info.mimeType }
            : {}),
        });
        await refreshBodyPhotoPreview();
      }
    } finally {
      setPickingPhoto(false);
    }
  }, [mutations, refreshBodyPhotoPreview]);

  const handleSaveProfile = useCallback(
    async (
      gender: string,
      sizes: Record<string, string>,
      stylePreferences: string,
    ) => {
      setSavingProfile(true);
      try {
        const hasSizes = Object.keys(sizes).length > 0;
        await mutations.setProfile({
          ...(gender ? { gender } : {}),
          ...(hasSizes ? { sizes } : {}),
          ...(stylePreferences ? { stylePreferences } : {}),
        });
      } finally {
        setSavingProfile(false);
      }
    },
    [mutations],
  );

  const hasGender = typeof profile?.gender === "string" && profile.gender.length > 0;
  const onboardingComplete = !!profile?.hasBodyPhoto && hasGender;
  const canGenerate = onboardingComplete && !!bodyPhotoPath;

  /**
   * Pull http(s) image URLs out of the prompt text so the user can paste a
   * link inline instead of fishing for an "attach URL" button. Anything that
   * looks like an image URL (.png/.jpg/.jpeg/.webp/.gif/.heic, optional
   * query string) gets promoted to an attachment chip and stripped from the
   * remaining text. Other URLs stay in the prompt verbatim.
   */
  const extractImageUrlsFromPrompt = useCallback(
    (text: string): { remaining: string; urls: string[] } => {
      const urlRe =
        /https?:\/\/[^\s<>"']+\.(?:png|jpe?g|webp|gif|heic)(?:\?[^\s<>"']*)?/gi;
      const urls = Array.from(new Set(text.match(urlRe) ?? []));
      const remaining = text.replace(urlRe, " ").replace(/\s+/g, " ").trim();
      return { remaining, urls };
    },
    [],
  );

  const handlePickTryOnImages = useCallback(async () => {
    const api = (window as {
      electronAPI?: {
        fashion?: {
          pickTryOnImages?: () => Promise<{
            canceled: boolean;
            paths: string[];
          }>;
        };
      };
    }).electronAPI;
    if (!api?.fashion?.pickTryOnImages) return;
    setPickingTryOn(true);
    try {
      const result = await api.fashion.pickTryOnImages();
      if (result.canceled || result.paths.length === 0) return;
      setTryOnImagePaths((prev) => Array.from(new Set([...prev, ...result.paths])));
    } finally {
      setPickingTryOn(false);
    }
  }, []);

  const handleRemoveAttachment = useCallback(
    (kind: "path" | "url", value: string) => {
      if (kind === "path") {
        setTryOnImagePaths((prev) => prev.filter((entry) => entry !== value));
      } else {
        setTryOnImageUrls((prev) => prev.filter((entry) => entry !== value));
      }
    },
    [],
  );

  // ── Drag-and-drop ────────────────────────────────────────────────────
  // The whole Fashion page is a drop zone for clothes images. We keep an
  // enter/leave counter so child re-enters don't flicker the overlay.
  // Dropped items route to the same try-on attachments as the + button:
  //   * Real on-disk image files → tryOnImagePaths (resolved via the
  //     preload's `webUtils.getPathForFile` shim).
  //   * Image URLs (dragged from a webpage as text/uri-list or text/plain)
  //     → tryOnImageUrls.
  const dragHasFiles = useCallback((event: ReactDragEvent<HTMLElement>) => {
    const items = event.dataTransfer?.items;
    if (!items) return false;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;
      if (item.kind === "file") return true;
      if (item.kind === "string" && /(uri-list|plain)/i.test(item.type))
        return true;
    }
    return false;
  }, []);

  const handleDragEnter = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!canGenerate) return;
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setIsDragOver(true);
    },
    [canGenerate, dragHasFiles],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!canGenerate) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    },
    [canGenerate],
  );

  const handleDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!canGenerate) return;

      const api = (window as {
        electronAPI?: {
          fashion?: { getDroppedFilePath?: (file: File) => string };
        };
      }).electronAPI;
      const getPath = api?.fashion?.getDroppedFilePath;

      const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
      const newPaths: string[] = [];
      for (const file of droppedFiles) {
        if (!file.type.startsWith("image/")) continue;
        const filePath = getPath?.(file);
        if (filePath) newPaths.push(filePath);
      }
      if (newPaths.length > 0) {
        setTryOnImagePaths((prev) =>
          Array.from(new Set([...prev, ...newPaths])),
        );
      }

      const uriListRaw = event.dataTransfer?.getData("text/uri-list") ?? "";
      const plainRaw = event.dataTransfer?.getData("text/plain") ?? "";
      const candidateUrls = `${uriListRaw}\n${plainRaw}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^https?:\/\//i.test(line));
      const imageUrlRe =
        /\.(?:png|jpe?g|webp|gif|heic)(?:\?[^\s<>"']*)?$/i;
      const newUrls = candidateUrls.filter((url) => imageUrlRe.test(url));
      if (newUrls.length > 0) {
        setTryOnImageUrls((prev) => Array.from(new Set([...prev, ...newUrls])));
      }
    },
    [canGenerate],
  );

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setGenerating(true);
    try {
      const api = (window as {
        electronAPI?: {
          fashion?: {
            startOutfitBatch?: (payload: {
              prompt?: string;
              batchId?: string;
              count?: number;
              excludeProductIds?: string[];
              seedHints?: string[];
            }) => Promise<{ threadId?: string; batchId: string }>;
            startTryOn?: (payload: {
              prompt?: string;
              batchId?: string;
              imagePaths?: string[];
              imageUrls?: string[];
            }) => Promise<{
              threadId?: string;
              batchId: string;
              imagePaths: string[];
              imageUrls: string[];
            }>;
          };
        };
      }).electronAPI;
      if (!api?.fashion?.startOutfitBatch || !api?.fashion?.startTryOn) {
        throw new Error("Fashion runtime is not available.");
      }

      // Pull any image URLs out of the prompt text first so a user who just
      // pasted a link still triggers the Try-On path even though they never
      // touched the + button.
      const { remaining, urls: detectedUrls } = extractImageUrlsFromPrompt(prompt);
      const allUrls = Array.from(new Set([...tryOnImageUrls, ...detectedUrls]));
      const useTryOn = tryOnImagePaths.length > 0 || allUrls.length > 0;

      if (useTryOn) {
        const batchId = `tryon-${Date.now().toString(36)}`;
        await api.fashion.startTryOn({
          prompt: remaining,
          batchId,
          imagePaths: tryOnImagePaths,
          imageUrls: allUrls,
        });
      } else {
        const batchId = `fashion-${Date.now().toString(36)}`;
        const excludeProductIds = Array.from(
          new Set(
            (outfits ?? []).flatMap((outfit) =>
              outfit.products.map((product) => product.productId),
            ),
          ),
        );
        await api.fashion.startOutfitBatch({
          prompt: remaining || "Generate a fresh fashion feed batch.",
          batchId,
          count: 5,
          excludeProductIds,
        });
      }

      setPrompt("");
      setTryOnImagePaths([]);
      setTryOnImageUrls([]);
    } finally {
      setTimeout(() => setGenerating(false), 800);
    }
  }, [
    canGenerate,
    extractImageUrlsFromPrompt,
    outfits,
    prompt,
    tryOnImagePaths,
    tryOnImageUrls,
  ]);

  const likedVariantIds = useMemo(
    () => new Set((likes ?? []).map((l) => l.variantId)),
    [likes],
  );
  const cartVariantIds = useMemo(
    () => new Set((cart ?? []).map((c) => c.variantId)),
    [cart],
  );

  const handleToggleLike = useCallback(
    async (product: FashionOutfitProduct) => {
      await mutations.toggleLike({
        variantId: product.variantId,
        productId: product.productId,
        title: product.title,
        merchantOrigin: product.merchantOrigin,
        ...(product.imageUrl !== undefined ? { imageUrl: product.imageUrl } : {}),
        ...(product.productUrl !== undefined
          ? { productUrl: product.productUrl }
          : {}),
        ...(typeof product.price === "number"
          ? { priceCents: Math.round(product.price * 100) }
          : {}),
        ...(product.currency !== undefined ? { currency: product.currency } : {}),
        ...(product.vendor !== undefined ? { vendor: product.vendor } : {}),
      });
    },
    [mutations],
  );

  const handleAddToCart = useCallback(
    async (product: FashionOutfitProduct) => {
      await mutations.addToCart({
        variantId: product.variantId,
        productId: product.productId,
        title: product.title,
        merchantOrigin: product.merchantOrigin,
        ...(product.imageUrl !== undefined ? { imageUrl: product.imageUrl } : {}),
        ...(product.productUrl !== undefined
          ? { productUrl: product.productUrl }
          : {}),
        ...(product.checkoutUrl !== undefined
          ? { checkoutUrl: product.checkoutUrl }
          : {}),
        ...(typeof product.price === "number"
          ? { priceCents: Math.round(product.price * 100) }
          : {}),
        ...(product.currency !== undefined ? { currency: product.currency } : {}),
        ...(product.vendor !== undefined ? { vendor: product.vendor } : {}),
        quantity: 1,
      });
    },
    [mutations],
  );

  const handleSetCartQuantity = useCallback(
    async (item: FashionCartItem, quantity: number) => {
      if (quantity <= 0) {
        await mutations.removeFromCart({ cartItemId: item._id });
      } else {
        await mutations.setCartQuantity({
          cartItemId: item._id,
          quantity,
        });
      }
    },
    [mutations],
  );

  const handleRemoveCartItem = useCallback(
    async (item: FashionCartItem) => {
      await mutations.removeFromCart({ cartItemId: item._id });
    },
    [mutations],
  );

  const handleCheckout = useCallback(async () => {
    if (!cart || cart.length === 0) return;
    const byMerchant = new Map<string, FashionCartItem[]>();
    for (const item of cart) {
      const existing = byMerchant.get(item.merchantOrigin) ?? [];
      existing.push(item);
      byMerchant.set(item.merchantOrigin, existing);
    }
    setCheckoutBusy(true);
    setCheckoutMessage(null);
    try {
      let openedCount = 0;
      let failedMessage: string | null = null;
      for (const [merchantOrigin, items] of byMerchant) {
        const lines = items.map((i) => ({
          variantId: i.variantId,
          quantity: i.quantity,
        }));
        try {
          const result = await checkoutAction({ merchantOrigin, lines });
          const url = result.continueUrl ?? result.cartUrl;
          if (url && typeof window !== "undefined") {
            window.open(url, "_blank", "noopener,noreferrer");
            openedCount += 1;
          }
        } catch (err) {
          const fallbackItem = items.find((i) => i.checkoutUrl);
          if (fallbackItem?.checkoutUrl && typeof window !== "undefined") {
            window.open(fallbackItem.checkoutUrl, "_blank", "noopener,noreferrer");
            openedCount += 1;
          } else {
            const message = err instanceof Error ? err.message : String(err);
            failedMessage = `Checkout failed for ${merchantOrigin}: ${message}`;
            setCheckoutMessage(failedMessage);
          }
        }
      }
      if (openedCount === 0 && !failedMessage) {
        setCheckoutMessage("No checkout URL available. Try clicking a product directly.");
      }
    } finally {
      setCheckoutBusy(false);
    }
  }, [cart, checkoutAction]);

  const initialSizes = useMemo(() => profile?.sizes ?? {}, [profile?.sizes]);
  const initialGender = profile?.gender ?? "";
  const initialPrefs = profile?.stylePreferences ?? "";

  // --- Feature gate: Shopify not configured ---
  if (featureStatus && !featureStatus.shopifyConfigured) {
    return (
      <div className="fashion-root">
        <div className="fashion-blank">
          <div className="fashion-blank-inner">
            <div className="fashion-blank-eyebrow">Fashion</div>
            <div className="fashion-blank-title">Not set up yet</div>
            <div className="fashion-blank-subtitle">
              Add <code>SHOPIFY_UCP_CLIENT_ID</code> and{" "}
              <code>SHOPIFY_UCP_CLIENT_SECRET</code> to your Convex deployment to
              enable Fashion.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const showProfileButton = onboardingComplete;
  const hasOutfits = (outfits?.length ?? 0) > 0;

  // --- Empty / pre-onboarding states (full-bleed, no card) ---
  let body: React.ReactNode;
  if (!onboardingComplete) {
    const needsPhoto = !profile?.hasBodyPhoto;
    body = (
      <div className="fashion-blank">
        <div className="fashion-blank-inner">
          <div className="fashion-blank-eyebrow">Fashion</div>
          <div className="fashion-blank-title">
            {needsPhoto
              ? "Add a body photo to see looks made for you."
              : "Add your style profile to guide searches."}
          </div>
          <div className="fashion-blank-subtitle">
            {needsPhoto
              ? "One full-body photo is all Stella needs. It stays on this Mac."
              : "Choose the department Stella should search so the products match you."}
          </div>
          <button
            type="button"
            className="fashion-blank-cta"
            onClick={() => {
              if (needsPhoto) {
                void handlePickPhoto();
              } else {
                setSheetOpen(true);
              }
            }}
            disabled={needsPhoto && pickingPhoto}
          >
            {needsPhoto ? (pickingPhoto ? "Choosing…" : "Choose photo") : "Open profile"}
          </button>
        </div>
      </div>
    );
  } else if (outfits === undefined) {
    body = (
      <div className="fashion-blank">
        <div className="fashion-blank-inner">
          <div className="fashion-stage-placeholder">Loading your looks…</div>
        </div>
      </div>
    );
  } else if (!hasOutfits) {
    body = (
      <div className="fashion-blank">
        <div className="fashion-blank-inner">
          <div className="fashion-blank-eyebrow">Fashion</div>
          <div className="fashion-blank-title">
            Generate your first looks.
          </div>
          <div className="fashion-blank-subtitle">
            Describe a vibe, occasion, or style — or just press the button.
          </div>
          <button
            type="button"
            className="fashion-blank-cta"
            onClick={() => void handleGenerate()}
            disabled={!canGenerate || generating}
          >
            {generating ? "Working…" : "Generate looks"}
          </button>
          {checkoutMessage ? (
            <div className="fashion-blank-error">{checkoutMessage}</div>
          ) : null}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="fashion-feed">
        {outfits.map((outfit) => (
          <OutfitStage
            key={outfit._id}
            outfit={outfit}
            likedVariantIds={likedVariantIds}
            cartVariantIds={cartVariantIds}
            onLike={handleToggleLike}
            onAddToCart={handleAddToCart}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="fashion-root"
      data-drag-over={isDragOver || undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
    >
      {body}

      {isDragOver ? (
        <div className="fashion-drop-overlay" aria-hidden>
          <div className="fashion-drop-overlay-inner">
            <div className="fashion-drop-overlay-title">
              Drop to try it on
            </div>
            <div className="fashion-drop-overlay-subtitle">
              Images of clothes — files or links from your browser
            </div>
          </div>
        </div>
      ) : null}

      {showProfileButton ? (
        <button
          type="button"
          className="fashion-profile-btn"
          onClick={() => setSheetOpen(true)}
          aria-label="Style profile"
          title="Style profile"
        >
          {bodyPhotoDataUrl ? (
            <img src={bodyPhotoDataUrl} alt="" />
          ) : (
            <span className="fashion-profile-btn-fallback">◎</span>
          )}
        </button>
      ) : null}

      {hasOutfits && canGenerate ? (
        <div className="fashion-prompt-dock">
          {tryOnImagePaths.length > 0 || tryOnImageUrls.length > 0 ? (
            <div className="fashion-prompt-attachments">
              {tryOnImageUrls.map((url) => (
                <div
                  key={`url-${url}`}
                  className="fashion-prompt-attachment"
                  title={url}
                >
                  <img src={url} alt="" />
                  <button
                    type="button"
                    className="fashion-prompt-attachment-x"
                    onClick={() => handleRemoveAttachment("url", url)}
                    aria-label="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              ))}
              {tryOnImagePaths.map((p) => {
                const name = p.split(/[/\\]/).pop() ?? p;
                return (
                  <div
                    key={`path-${p}`}
                    className="fashion-prompt-attachment fashion-prompt-attachment--file"
                    title={p}
                  >
                    <span className="fashion-prompt-attachment-name">{name}</span>
                    <button
                      type="button"
                      className="fashion-prompt-attachment-x"
                      onClick={() => handleRemoveAttachment("path", p)}
                      aria-label="Remove attachment"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          <button
            type="button"
            className="fashion-prompt-attach"
            onClick={() => void handlePickTryOnImages()}
            disabled={pickingTryOn}
            aria-label="Attach clothes images"
            title="Attach clothes images to try on"
          >
            +
          </button>
          <input
            className="fashion-prompt-input"
            placeholder={
              tryOnImagePaths.length > 0 || tryOnImageUrls.length > 0
                ? "Try these clothes on — add notes (optional)"
                : "Describe a vibe — or drop / paste a clothes image"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleGenerate();
              }
            }}
          />
          <button
            type="button"
            className="fashion-prompt-send"
            onClick={() => void handleGenerate()}
            disabled={generating}
          >
            {generating
              ? "…"
              : tryOnImagePaths.length > 0 || tryOnImageUrls.length > 0
                ? "Try on"
                : "Generate"}
          </button>
        </div>
      ) : null}

      <CartDock
        cart={cart ?? []}
        busy={checkoutBusy}
        onCheckout={() => void handleCheckout()}
        onSetQuantity={(item, quantity) =>
          void handleSetCartQuantity(item, quantity)
        }
        onRemove={(item) => void handleRemoveCartItem(item)}
      />

      {sheetOpen ? (
        <ProfileSheet
          initialGender={initialGender}
          initialSizes={initialSizes}
          initialPrefs={initialPrefs}
          hasBodyPhoto={!!profile?.hasBodyPhoto}
          bodyPhotoDataUrl={bodyPhotoDataUrl}
          onPickPhoto={handlePickPhoto}
          onSave={handleSaveProfile}
          onClose={() => setSheetOpen(false)}
          saving={savingProfile || pickingPhoto}
        />
      ) : null}
    </div>
  );
};
