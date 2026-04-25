import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/api";

export type FashionProfile = {
  _id: string;
  ownerId: string;
  displayName?: string;
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

export type FashionLike = {
  _id: string;
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

export type FashionFeatureStatus = {
  shopifyConfigured: boolean;
};

export const useFashionFeatureStatus = () =>
  useQuery(api.data.fashion.getFashionFeatureStatus, {}) as
    | FashionFeatureStatus
    | undefined;

export const useFashionProfile = () =>
  useQuery(api.data.fashion.getProfile, {}) as FashionProfile | null | undefined;

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
  const toggleLike = useMutation(api.data.fashion.toggleLike);
  const addToCart = useMutation(api.data.fashion.addToCart);
  const removeFromCart = useMutation(api.data.fashion.removeFromCart);
  const setCartQuantity = useMutation(api.data.fashion.setCartQuantity);
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

export type CheckoutResult = {
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
