import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/api";

type FashionProfile = {
  _id: string;
  ownerId: string;
  displayName?: string;
  gender?: string;
  sizes?: Record<string, string>;
  stylePreferences?: string;
  hasBodyPhoto: boolean;
  bodyPhotoMimeType?: string;
  bodyPhotoUpdatedAt?: number;
  updatedAt: number;
};

export type FashionOutfitProduct = {
  slot: string;
  productId: string;
  variantId: string;
  title: string;
  vendor?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  checkoutUrl?: string;
  merchantOrigin: string;
};

export type FashionOutfit = {
  _id: string;
  _creationTime: number;
  ownerId: string;
  batchId: string;
  ordinal: number;
  status: "generating" | "ready" | "failed";
  themeLabel: string;
  themeDescription?: string;
  stylePrompt?: string;
  products: FashionOutfitProduct[];
  tryOnPrompt?: string;
  tryOnImagePath?: string;
  tryOnImageUrl?: string;
  errorMessage?: string;
  createdAt: number;
  readyAt?: number;
};

type FashionLike = {
  _id: string;
  _creationTime?: number;
  ownerId: string;
  variantId: string;
  productId: string;
  title: string;
  imageUrl?: string;
  productUrl?: string;
  merchantOrigin: string;
  priceCents?: number;
  currency?: string;
  vendor?: string;
  likedAt: number;
};

export type FashionCartItem = {
  _id: string;
  _creationTime?: number;
  ownerId: string;
  variantId: string;
  productId: string;
  title: string;
  imageUrl?: string;
  productUrl?: string;
  checkoutUrl?: string;
  merchantOrigin: string;
  priceCents?: number;
  currency?: string;
  vendor?: string;
  quantity: number;
  addedAt: number;
};

type FashionFeatureStatus = {
  shopifyConfigured: boolean;
};

export const useFashionFeatureStatus = () =>
  useQuery(api.data.fashion.getFashionFeatureStatus, {}) as
    | FashionFeatureStatus
    | undefined;

export const useFashionProfile = () =>
  useQuery(api.data.fashion.getProfile, {}) as
    | FashionProfile
    | null
    | undefined;

export const useFashionOutfits = () =>
  useQuery(api.data.fashion.listOutfits, { limit: 60 }) as
    | FashionOutfit[]
    | undefined;

export const useFashionLikes = () =>
  useQuery(api.data.fashion.listLikes, { limit: 100 }) as
    | FashionLike[]
    | undefined;

export const useFashionCart = () =>
  useQuery(api.data.fashion.listCart, {}) as FashionCartItem[] | undefined;

export const useFashionMutations = () => {
  const setProfile = useMutation(api.data.fashion.setProfile);
  const setBodyPhotoFlag = useMutation(api.data.fashion.setBodyPhotoFlag);
  const toggleLike = useMutation(
    api.data.fashion.toggleLike,
  ).withOptimisticUpdate((localStore, args) => {
    const queryArgs = { limit: 100 };
    const existingLikes = localStore.getQuery(
      api.data.fashion.listLikes,
      queryArgs,
    ) as FashionLike[] | undefined;
    if (existingLikes === undefined) return;

    const existing = existingLikes.find(
      (like) => like.variantId === args.variantId,
    );
    if (existing) {
      localStore.setQuery(
        api.data.fashion.listLikes,
        queryArgs,
        existingLikes.filter((like) => like.variantId !== args.variantId),
      );
      return;
    }

    const now = Date.now();
    localStore.setQuery(api.data.fashion.listLikes, queryArgs, [
      {
        _id: `optimistic:like:${args.variantId}:${now}`,
        _creationTime: now,
        ownerId: "optimistic",
        variantId: args.variantId,
        productId: args.productId,
        title: args.title,
        ...(args.imageUrl !== undefined ? { imageUrl: args.imageUrl } : {}),
        ...(args.productUrl !== undefined
          ? { productUrl: args.productUrl }
          : {}),
        merchantOrigin: args.merchantOrigin,
        ...(typeof args.priceCents === "number"
          ? { priceCents: Math.floor(args.priceCents) }
          : {}),
        ...(args.currency !== undefined ? { currency: args.currency } : {}),
        ...(args.vendor !== undefined ? { vendor: args.vendor } : {}),
        likedAt: now,
      },
      ...existingLikes,
    ]);
  });
  const addToCart = useMutation(
    api.data.fashion.addToCart,
  ).withOptimisticUpdate((localStore, args) => {
    const existingCart = localStore.getQuery(api.data.fashion.listCart, {}) as
      | FashionCartItem[]
      | undefined;
    if (existingCart === undefined) return;

    const quantity = Math.max(1, Math.min(99, Math.floor(args.quantity ?? 1)));
    const existing = existingCart.find(
      (item) => item.variantId === args.variantId,
    );
    if (existing) {
      localStore.setQuery(
        api.data.fashion.listCart,
        {},
        existingCart.map((item) =>
          item.variantId === args.variantId
            ? {
                ...item,
                quantity: Math.max(1, Math.min(99, item.quantity + quantity)),
              }
            : item,
        ),
      );
      return;
    }

    const now = Date.now();
    localStore.setQuery(api.data.fashion.listCart, {}, [
      {
        _id: `optimistic:cart:${args.variantId}:${now}`,
        _creationTime: now,
        ownerId: "optimistic",
        variantId: args.variantId,
        productId: args.productId,
        title: args.title,
        ...(args.imageUrl !== undefined ? { imageUrl: args.imageUrl } : {}),
        ...(args.productUrl !== undefined
          ? { productUrl: args.productUrl }
          : {}),
        ...(args.checkoutUrl !== undefined
          ? { checkoutUrl: args.checkoutUrl }
          : {}),
        merchantOrigin: args.merchantOrigin,
        ...(typeof args.priceCents === "number"
          ? { priceCents: Math.floor(args.priceCents) }
          : {}),
        ...(args.currency !== undefined ? { currency: args.currency } : {}),
        ...(args.vendor !== undefined ? { vendor: args.vendor } : {}),
        quantity,
        addedAt: now,
      },
      ...existingCart,
    ]);
  });
  const removeFromCart = useMutation(
    api.data.fashion.removeFromCart,
  ).withOptimisticUpdate((localStore, args) => {
    const existingCart = localStore.getQuery(api.data.fashion.listCart, {}) as
      | FashionCartItem[]
      | undefined;
    if (existingCart === undefined) return;
    localStore.setQuery(
      api.data.fashion.listCart,
      {},
      existingCart.filter((item) => item._id !== args.cartItemId),
    );
  });
  const setCartQuantity = useMutation(
    api.data.fashion.setCartQuantity,
  ).withOptimisticUpdate((localStore, args) => {
    const existingCart = localStore.getQuery(api.data.fashion.listCart, {}) as
      | FashionCartItem[]
      | undefined;
    if (existingCart === undefined) return;

    const quantity = Math.floor(args.quantity);
    localStore.setQuery(
      api.data.fashion.listCart,
      {},
      quantity <= 0
        ? existingCart.filter((item) => item._id !== args.cartItemId)
        : existingCart.map((item) =>
            item._id === args.cartItemId
              ? { ...item, quantity: Math.min(99, quantity) }
              : item,
          ),
    );
  });
  const deleteOutfit = useMutation(api.data.fashion.deleteOutfit);
  return {
    setProfile,
    setBodyPhotoFlag,
    toggleLike,
    addToCart,
    removeFromCart,
    setCartQuantity,
    deleteOutfit,
  };
};

type CheckoutResult = {
  checkoutId: string;
  status: string;
  continueUrl?: string;
  cartUrl?: string;
  merchantOrigin: string;
  mcpEndpoint: string;
  usingMcp: boolean;
};

export const useFashionCheckoutAction = () => {
  return useAction(api.agent.local_runtime.shopifyCreateCheckout) as (args: {
    merchantOrigin: string;
    lines: Array<{ variantId: string; quantity: number }>;
  }) => Promise<CheckoutResult>;
};

export const formatPrice = (
  amount: number | undefined,
  currency: string | undefined,
): string => {
  if (typeof amount !== "number") return "";
  const code = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
};

export const formatPriceCents = (
  cents: number | undefined,
  currency: string | undefined,
): string => {
  if (typeof cents !== "number") return "";
  return formatPrice(cents / 100, currency);
};
