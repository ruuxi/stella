import type { UserPetRecord } from "./user-pet-data";

const PET_SHARE_PREFIX = "stella://pet/";

export const buildUserPetShareLink = (
  username: string,
  petId: string,
): string => `${PET_SHARE_PREFIX}${username.toLowerCase()}/${petId.toLowerCase()}`;

export const getUserPetShareLink = (pet: UserPetRecord): string | null =>
  pet.authorUsername
    ? buildUserPetShareLink(pet.authorUsername, pet.petId)
    : null;

export const buildUserPetShareMessage = (pet: UserPetRecord): string | null => {
  const link = getUserPetShareLink(pet);
  if (!link) return null;
  return `Check out this Stella pet: ${pet.displayName}\n${link}`;
};
