import type { ScreenDefinition, ScreenDescriptor } from "./screen-types";

type ScreenModule = {
  screen?: ScreenDefinition;
  default?: ScreenDefinition;
};

const modules = import.meta.glob("../registry/*Screen.tsx", {
  eager: true,
}) as Record<string, ScreenModule>;

const loadScreens = (): ScreenDefinition[] => {
  const screens: ScreenDefinition[] = [];
  const seen = new Set<string>();
  for (const mod of Object.values(modules)) {
    const definition = mod.screen ?? mod.default;
    if (!definition?.id || !definition?.component) {
      continue;
    }
    if (seen.has(definition.id)) {
      console.warn(`Duplicate screen id detected: ${definition.id}`);
      continue;
    }
    seen.add(definition.id);
    screens.push(definition);
  }
  screens.sort((a, b) => a.title.localeCompare(b.title));
  return screens;
};

const definitions = loadScreens();

const toDescriptor = (definition: ScreenDefinition): ScreenDescriptor => {
  const commands = definition.commands
    ? Object.entries(definition.commands)
        .map(([name, descriptor]) => ({
          name,
          description: descriptor.description,
          schema: descriptor.schema,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    commands,
  };
};

export const getScreenDefinitions = () => definitions.slice();

export const getScreenDefinition = (screenId: string) =>
  definitions.find((definition) => definition.id === screenId) ?? null;

export const getScreenDescriptors = () => definitions.map((definition) => toDescriptor(definition));
