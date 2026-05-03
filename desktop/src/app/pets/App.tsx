import { useEffect, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { PetSprite } from "@/shell/pet/PetSprite";
import {
  BUILT_IN_PETS,
  DEFAULT_PET_ID,
  PET_TAGS,
  type BuiltInPet,
} from "@/shell/pet/built-in-pets";
import {
  readPetOpenPreference,
  useSelectedPetId,
  writePetOpenPreference,
} from "@/shell/pet/pet-preferences";
import "./pets.css";

const ALL_TAG = "all" as const;

const filterPets = (
  pets: BuiltInPet[],
  tag: string,
  query: string,
): BuiltInPet[] => {
  const trimmed = query.trim().toLowerCase();
  return pets.filter((pet) => {
    if (tag !== ALL_TAG && !pet.tags.includes(tag)) return false;
    if (!trimmed) return true;
    return (
      pet.displayName.toLowerCase().includes(trimmed) ||
      pet.description.toLowerCase().includes(trimmed) ||
      pet.creator.toLowerCase().includes(trimmed)
    );
  });
};

/**
 * Pet picker — shows every bundled pet with its sprite, name, and
 * description. Clicking a card selects that pet (the overlay re-renders
 * via the `useSelectedPetId` `storage` event subscription) and toggles
 * the floating mascot on if it isn't already.
 */
export const PetsApp = () => {
  const [selectedPetId, setSelectedPetId] = useSelectedPetId(DEFAULT_PET_ID);
  const [activeTag, setActiveTag] = useState<string>(ALL_TAG);
  const [query, setQuery] = useState("");
  const [petOpen, setPetOpenState] = useState<boolean>(() =>
    readPetOpenPreference(),
  );

  // Mirror the IPC-driven open state so the toggle reflects updates from
  // the overlay (e.g. user closed via right-click context menu).
  useEffect(() => {
    const cleanup = window.electronAPI?.pet?.onSetOpen?.((open) => {
      setPetOpenState(open);
    });
    return () => cleanup?.();
  }, []);

  const filteredPets = useMemo(
    () => filterPets(BUILT_IN_PETS, activeTag, query),
    [activeTag, query],
  );

  const handleSelect = (id: string) => {
    setSelectedPetId(id);
    if (!petOpen) {
      writePetOpenPreference(true);
      setPetOpenState(true);
      window.electronAPI?.pet?.setOpen?.(true);
    }
  };

  const handleToggle = () => {
    const next = !petOpen;
    writePetOpenPreference(next);
    setPetOpenState(next);
    window.electronAPI?.pet?.setOpen?.(next);
  };

  return (
    <main className="pets-page" data-stella-section="pets">
      <header className="pets-page-header">
        <h1 className="pets-page-title">Pets</h1>
        <p className="pets-page-subtitle">
          Pick a floating Stella companion to perch above your work. Pets react
          to what Stella is doing — running, waiting on you, or just hanging
          out — and surface their last status without making you switch
          windows. Right-click the pet anywhere on screen to swap or close it.
        </p>
      </header>

      <div className="pets-toolbar">
        <input
          type="search"
          placeholder="Search pets"
          className="settings-input"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          style={{
            background: "transparent",
            border: "1px solid var(--color-token-border)",
            color: "var(--color-token-foreground)",
            padding: "6px 10px",
            borderRadius: 8,
            fontSize: 12,
            minWidth: 200,
          }}
          data-stella-action="search-pets"
          data-stella-label="Search pets"
        />
        <div className="pets-toolbar-tags">
          <button
            type="button"
            className="pets-tag-pill"
            data-active={activeTag === ALL_TAG ? "true" : "false"}
            onClick={() => setActiveTag(ALL_TAG)}
          >
            All
          </button>
          {PET_TAGS.map((tag) => (
            <button
              key={tag}
              type="button"
              className="pets-tag-pill"
              data-active={activeTag === tag ? "true" : "false"}
              onClick={() => setActiveTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
        <div className="pets-toolbar-actions">
          <Button
            variant="secondary"
            size="small"
            disabled
            title="Create-your-own pet is coming soon"
            data-stella-action="create-pet"
            data-stella-label="Create pet"
            data-stella-state="coming-soon"
          >
            Create pet
          </Button>
          <Button
            variant={petOpen ? "secondary" : "primary"}
            size="small"
            onClick={handleToggle}
            data-stella-action="toggle-pet"
            data-stella-label={petOpen ? "Hide pet" : "Show pet"}
            data-stella-state={petOpen ? "active" : "inactive"}
          >
            {petOpen ? "Hide pet" : "Show pet"}
          </Button>
        </div>
      </div>

      {filteredPets.length === 0 ? (
        <div className="pets-empty">
          No pets match that filter — try a different tag or clear the search.
        </div>
      ) : (
        <div className="pets-grid">
          {filteredPets.map((pet) => {
            const isSelected = pet.id === selectedPetId;
            return (
              <div key={pet.id} className="pets-card-wrapper">
                <button
                  type="button"
                  className="pets-card"
                  data-selected={isSelected ? "true" : "false"}
                  onClick={() => handleSelect(pet.id)}
                  data-stella-action="select-pet"
                  data-stella-label={pet.displayName}
                  data-stella-state={isSelected ? "selected" : "available"}
                >
                  <div className="pets-card-sprite">
                    <PetSprite
                      spritesheetUrl={pet.spritesheetUrl}
                      state="idle"
                      size={84}
                    />
                  </div>
                  <div className="pets-card-name">{pet.displayName}</div>
                  <div className="pets-card-description">{pet.description}</div>
                  <div className="pets-card-creator">by {pet.creator}</div>
                </button>
                {isSelected && (
                  <span className="pets-card-selected-badge">Selected</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
};

export default PetsApp;
