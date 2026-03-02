/**
 * Identity Map - Persistent Pseudonymization Layer
 *
 * Maps real contact names/identifiers to fake aliases so the LLM/backend
 * never sees real PII. The mapping persists at ~/.stella/state/identity_map.json.
 */

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import type {
  IdentityMap,
  IdentityMappingSource,
} from "./discovery_types.js";
import { protectValue, unprotectValue } from "./protected_storage.js";

const log = (...args: unknown[]) => console.log("[identity-map]", ...args);
const IDENTITY_NAME_SCOPE = "identity-map-real-name";
const IDENTITY_IDENTIFIER_SCOPE = "identity-map-real-identifier";

// Name pools for alias generation
const FIRST_NAMES = [
  "Adrian",
  "Blake",
  "Carmen",
  "Dana",
  "Ellis",
  "Finley",
  "Glenn",
  "Harper",
  "Ivory",
  "Jules",
  "Kai",
  "Lane",
  "Morgan",
  "Noel",
  "Oakley",
  "Parker",
  "Quinn",
  "Reed",
  "Sage",
  "Taylor",
  "Uma",
  "Val",
  "Winter",
  "Xen",
  "Yael",
  "Zara",
  "Archer",
  "Briar",
  "Cedar",
  "Devon",
  "Ember",
  "Fern",
  "Gray",
  "Haven",
  "Indigo",
  "Jordan",
  "Kira",
  "Lark",
  "Milan",
  "Nova",
  "Onyx",
  "Phoenix",
  "Raven",
  "Skylar",
  "Tatum",
  "Unity",
  "Vesper",
  "Wren",
  "Xander",
  "Zephyr",
  "Aspen",
  "Blair",
  "Cove",
  "Darcy",
  "Emery",
  "Flynn",
  "Greer",
  "Hollis",
  "Iris",
  "Jude",
  "Keegan",
  "Leander",
  "Marlow",
  "Nico",
  "Orion",
  "Pax",
  "Reese",
  "Shea",
  "Tobin",
  "Ursa",
  "Vivian",
  "West",
  "Yara",
  "Zion",
  "Avery",
  "Beck",
  "Cade",
  "Drew",
  "Eden",
  "Fox",
  "Gemma",
  "Hale",
  "Ira",
  "Jasper",
  "Kit",
  "Lennox",
  "Mars",
  "Neve",
  "Opal",
  "Penn",
  "Rio",
  "Scout",
  "True",
  "Valor",
  "Wade",
  "Ximena",
  "York",
  "Zola",
];

const LAST_NAMES = [
  "Ashford",
  "Bellamy",
  "Calloway",
  "Dalton",
  "Everhart",
  "Fairchild",
  "Gallagher",
  "Hartwell",
  "Irvine",
  "Jennings",
  "Kensington",
  "Langford",
  "Mercer",
  "Northcott",
  "Osborne",
  "Pemberton",
  "Quinlan",
  "Redmond",
  "Sterling",
  "Thorne",
  "Underwood",
  "Vance",
  "Whitfield",
  "Yardley",
  "Zimmerman",
  "Aldridge",
  "Blackwell",
  "Cromwell",
  "Davenport",
  "Ellsworth",
  "Fletcher",
  "Garrison",
  "Holloway",
  "Isherwood",
  "Jarrett",
  "Kingsley",
  "Lockwood",
  "Montague",
  "Norwood",
  "Oakwell",
  "Prescott",
  "Ramsey",
  "Sinclair",
  "Thornton",
  "Upton",
  "Vaughn",
  "Westbrook",
  "Ainsley",
  "Bradford",
  "Castillo",
  "Donovan",
  "Eastwood",
  "Finch",
  "Gentry",
  "Hawthorne",
  "Ingram",
  "Jessup",
  "Kimball",
  "Lancaster",
  "Moreland",
  "Newell",
  "Ogden",
  "Porter",
  "Rowan",
  "Sawyer",
  "Trask",
  "Ulrich",
  "Wakefield",
  "Abbott",
  "Brinley",
  "Chandler",
  "Drake",
  "Elwood",
  "Frost",
  "Graves",
  "Henley",
  "Irving",
  "Kemp",
  "Linden",
  "Maxwell",
  "Nash",
  "Olivier",
  "Pearce",
  "Roland",
  "Sutton",
  "Trent",
  "Vernon",
  "Winslow",
  "Alden",
  "Burke",
  "Cross",
  "Delaney",
  "Emerson",
  "Foley",
  "Grant",
  "Hayes",
  "Ives",
];

/**
 * Generate a deterministic alias from a real identifier
 */
export function generateAlias(realIdentifier: string): {
  name: string;
  identifier: string;
} {
  // Create SHA-256 hash of the real identifier
  const hash = createHash("sha256").update(realIdentifier).digest("hex");

  // Take first 8 hex chars and parse as int
  const hashInt = parseInt(hash.substring(0, 8), 16);

  // Pick first name deterministically
  const firstNameIndex = hashInt % FIRST_NAMES.length;
  const firstName = FIRST_NAMES[firstNameIndex];

  // Pick last name deterministically
  const lastNameIndex =
    Math.floor(hashInt / FIRST_NAMES.length) % LAST_NAMES.length;
  const lastName = LAST_NAMES[lastNameIndex];

  const fullName = `${firstName} ${lastName}`;

  // Generate fake identifier
  let fakeIdentifier: string;

  if (realIdentifier.includes("@")) {
    // Email format
    fakeIdentifier = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`;
  } else {
    // Phone number format - generate from hash bytes
    const hashBytes = Buffer.from(hash, "hex");
    const digit1 = (hashBytes[0] % 8) + 2; // 2-9
    const digit2 = hashBytes[1] % 10;
    const digit3 = hashBytes[2] % 10;
    const digit4 = hashBytes[3] % 10;
    const digit5 = hashBytes[4] % 10;
    const digit6 = hashBytes[5] % 10;
    const digit7 = hashBytes[6] % 10;
    const digit8 = hashBytes[7] % 10;
    const digit9 = hashBytes[8] % 10;
    const digit10 = hashBytes[9] % 10;

    fakeIdentifier = `+1-${digit1}${digit2}${digit3}-${digit4}${digit5}${digit6}-${digit7}${digit8}${digit9}${digit10}`;
  }

  return {
    name: fullName,
    identifier: fakeIdentifier,
  };
}

/**
 * Load the identity map from disk
 */
export async function loadIdentityMap(
  stellaHome: string
): Promise<IdentityMap> {
  const mapPath = path.join(stellaHome, "state", "identity_map.json");

  try {
    const content = await fs.readFile(mapPath, "utf-8");
    const map = JSON.parse(content) as IdentityMap;

    if (map.version !== 1) {
      log(`Unsupported identity map version: ${map.version}`);
      return { version: 1, mappings: [] };
    }

    const mappings: IdentityMap["mappings"] = [];
    for (const mapping of map.mappings ?? []) {
      const realName = unprotectValue(
        IDENTITY_NAME_SCOPE,
        mapping.real?.name ?? "",
      );
      const realIdentifier = unprotectValue(
        IDENTITY_IDENTIFIER_SCOPE,
        mapping.real?.identifier ?? "",
      );

      if (realName === null || realIdentifier === null) {
        continue;
      }

      mappings.push({
        real: {
          name: realName,
          identifier: realIdentifier,
        },
        alias: mapping.alias,
        source: mapping.source,
      });
    }

    return { version: 1, mappings };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist yet
      return { version: 1, mappings: [] };
    }
    throw error;
  }
}

/**
 * Save the identity map to disk
 */
export async function saveIdentityMap(
  stellaHome: string,
  map: IdentityMap
): Promise<void> {
  const stateDir = path.join(stellaHome, "state");
  const mapPath = path.join(stateDir, "identity_map.json");
  const protectedMap: IdentityMap = {
    version: 1,
    mappings: map.mappings.map((mapping) => ({
      real: {
        name: protectValue(IDENTITY_NAME_SCOPE, mapping.real.name),
        identifier: protectValue(
          IDENTITY_IDENTIFIER_SCOPE,
          mapping.real.identifier,
        ),
      },
      alias: mapping.alias,
      source: mapping.source,
    })),
  };

  // Ensure state directory exists
  await fs.mkdir(stateDir, { recursive: true });

  // Write map with pretty formatting
  await fs.writeFile(mapPath, JSON.stringify(protectedMap, null, 2), "utf-8");
}

/**
 * Add contacts to the identity map (creates aliases for new contacts)
 */
export async function addContacts(
  stellaHome: string,
  contacts: {
    name: string;
    identifier: string;
    source: IdentityMappingSource;
  }[]
): Promise<IdentityMap> {
  const map = await loadIdentityMap(stellaHome);

  for (const contact of contacts) {
    // Check if mapping already exists for this identifier
    const existing = map.mappings.find(
      (m) => m.real.identifier === contact.identifier
    );

    if (!existing) {
      // Generate new alias
      const alias = generateAlias(contact.identifier);

      // Add mapping
      map.mappings.push({
        real: {
          name: contact.name,
          identifier: contact.identifier,
        },
        alias,
        source: contact.source,
      });

      log(
        `Added mapping: ${contact.name} (${contact.identifier}) → ${alias.name} (${alias.identifier})`
      );
    }
  }

  // Save updated map
  await saveIdentityMap(stellaHome, map);

  return map;
}

/**
 * Replace real identifiers with aliases in text
 */
export function pseudonymize(text: string, map: IdentityMap): string {
  if (!text || map.mappings.length === 0) {
    return text;
  }

  // Build replacement pairs: real → alias
  const replacements: Array<{
    real: string;
    alias: string;
    isIdentifier: boolean;
  }> = [];

  for (const mapping of map.mappings) {
    replacements.push({
      real: mapping.real.name,
      alias: mapping.alias.name,
      isIdentifier: false,
    });
    replacements.push({
      real: mapping.real.identifier,
      alias: mapping.alias.identifier,
      isIdentifier: true,
    });
  }

  // Sort by length descending to avoid partial matches
  replacements.sort((a, b) => b.real.length - a.real.length);

  let result = text;

  for (const { real, alias, isIdentifier } of replacements) {
    if (isIdentifier) {
      // For phone numbers: match with or without formatting
      const digitsOnly = real.replace(/\D/g, "");
      if (digitsOnly.length >= 10) {
        // Match various phone number formats
        const phonePattern = new RegExp(
          digitsOnly.split("").join("\\D*"),
          "g"
        );
        result = result.replace(phonePattern, alias);
      }

      // Also do exact match for emails
      const escapedReal = real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exactPattern = new RegExp(escapedReal, "gi");
      result = result.replace(exactPattern, alias);
    } else {
      // For names: word-boundary-aware, case-insensitive replacement
      const escapedReal = real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const namePattern = new RegExp(`\\b${escapedReal}\\b`, "gi");
      result = result.replace(namePattern, alias);
    }
  }

  return result;
}

/**
 * Replace aliases with real identifiers in text (reverse of pseudonymize)
 */
export function depseudonymize(text: string, map: IdentityMap): string {
  if (!text || map.mappings.length === 0) {
    return text;
  }

  // Build replacement pairs: alias → real
  const replacements: Array<{
    alias: string;
    real: string;
    isIdentifier: boolean;
  }> = [];

  for (const mapping of map.mappings) {
    replacements.push({
      alias: mapping.alias.name,
      real: mapping.real.name,
      isIdentifier: false,
    });
    replacements.push({
      alias: mapping.alias.identifier,
      real: mapping.real.identifier,
      isIdentifier: true,
    });
  }

  // Sort by length descending to avoid partial matches
  replacements.sort((a, b) => b.alias.length - a.alias.length);

  let result = text;

  for (const { alias, real, isIdentifier } of replacements) {
    if (isIdentifier) {
      // For phone numbers: match with or without formatting
      const digitsOnly = alias.replace(/\D/g, "");
      if (digitsOnly.length >= 10) {
        // Match various phone number formats
        const phonePattern = new RegExp(
          digitsOnly.split("").join("\\D*"),
          "g"
        );
        result = result.replace(phonePattern, real);
      }

      // Also do exact match for emails
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exactPattern = new RegExp(escapedAlias, "gi");
      result = result.replace(exactPattern, real);
    } else {
      // For names: word-boundary-aware, case-insensitive replacement
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const namePattern = new RegExp(`\\b${escapedAlias}\\b`, "gi");
      result = result.replace(namePattern, real);
    }
  }

  return result;
}
