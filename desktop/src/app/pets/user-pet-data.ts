import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { api } from "@/convex/api";

export type UserPetVisibility = "public" | "unlisted" | "private";

export type UserPetRecord = {
  _id: string;
  _creationTime: number;
  ownerId: string;
  petId: string;
  displayName: string;
  description: string;
  prompt?: string;
  spritesheetUrl: string;
  previewUrl?: string;
  visibility: UserPetVisibility;
  searchText: string;
  authorUsername?: string;
  installCount?: number;
  createdAt: number;
  updatedAt: number;
};

export type UserPetUploadTarget = {
  key: string;
  publicUrl: string;
  putUrl: string;
  headers: Record<string, string>;
};

export type UserPetUploadUrl = {
  uploadId: string;
  spritesheet: UserPetUploadTarget;
  preview?: UserPetUploadTarget;
};

const PAGE_SIZE = 24;

export function usePublicUserPets(search?: string) {
  return usePaginatedQuery(
    api.data.user_pets.listPublicPage,
    search?.trim() ? { search: search.trim() } : {},
    { initialNumItems: PAGE_SIZE },
  ) as {
    results: UserPetRecord[];
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
    loadMore: (numItems: number) => void;
  };
}

export function useMyUserPets(enabled: boolean) {
  return useQuery(
    api.data.user_pets.listMine,
    enabled ? {} : "skip",
  ) as UserPetRecord[] | undefined;
}

export function useUserPet(petId: string | null) {
  return useQuery(
    api.data.user_pets.getByPetId,
    petId ? { petId } : "skip",
  ) as UserPetRecord | null | undefined;
}

export function useUserPetMutations() {
  return {
    createPet: useMutation(api.data.user_pets.createPet),
    setVisibility: useMutation(api.data.user_pets.setVisibility),
    deletePet: useMutation(api.data.user_pets.deletePet),
    recordInstall: useMutation(api.data.user_pets.recordInstall),
  };
}

export function useCreateUserPetUploadUrl() {
  return useAction(api.data.user_pet_uploads.createUploadUrl) as (args: {
    petId: string;
    spritesheetSha256: string;
    previewSha256?: string;
    contentType?: string;
  }) => Promise<UserPetUploadUrl>;
}
