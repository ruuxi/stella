export type SelfModLevel = "low" | "medium" | "high";

export type SelfModStage = {
  id: SelfModLevel;
  title: string;
  prompt: string;
};

export const SELF_MOD_STAGES: SelfModStage[] = [
  { id: "low", title: "Low", prompt: "Make my messages blue." },
  { id: "medium", title: "Medium", prompt: "Make the app feel more modern." },
  { id: "high", title: "High", prompt: "Turn this into a cozy cat-themed shell." },
];
